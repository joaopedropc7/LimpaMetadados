// Limpeza e leitura de metadados de vídeos MP4/MOV (ISO BMFF) e WebM/MKV
// (Matroska). Os metadados são sobrescritos no lugar com blocos vazios do
// mesmo tamanho, então nenhum offset interno precisa ser recalculado e o
// áudio/vídeo não é recodificado. O arquivo é lido em partes, sem carregar
// o vídeo inteiro na memória.

import { ascii } from './imageFormat'
import { isPrintable, parseC2pa, parseXmp } from './inspectMetadata'

const utf8 = new TextDecoder('utf-8')

// Marcas "ftyp" de HEIC/AVIF: são imagens, não vídeos
const IMAGE_BRANDS = /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1|avif|avis|avci)$/

export function detectVideoFormat(head) {
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'matroska'
  const type = ascii(head, 4, 4)
  if (type === 'ftyp') return IMAGE_BRANDS.test(ascii(head, 8, 4).trim()) ? null : 'mp4'
  // QuickTime antigo, sem "ftyp"
  if (['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(type)) return 'mp4'
  return null
}

// Leitura aleatória do arquivo com um buffer de 1 MB
class RandomAccess {
  constructor(file) {
    this.file = file
    this.start = 0
    this.buf = new Uint8Array(0)
  }

  async read(pos, len) {
    len = Math.max(0, Math.min(len, this.file.size - pos))
    if (pos < this.start || pos + len > this.start + this.buf.length) {
      this.buf = new Uint8Array(await this.file.slice(pos, pos + Math.max(len, 1 << 20)).arrayBuffer())
      this.start = pos
    }
    return this.buf.subarray(pos - this.start, pos - this.start + len)
  }
}

// Monta o arquivo final: trechos originais intercalados com os trechos alterados
function assemble(file, patches) {
  patches.sort((a, b) => a.offset - b.offset)
  const parts = []
  let cursor = 0
  for (const p of patches) {
    if (p.offset < cursor || p.offset + p.bytes.length > file.size) continue
    parts.push(file.slice(cursor, p.offset), p.bytes)
    cursor = p.offset + p.bytes.length
  }
  parts.push(file.slice(cursor))
  return new Blob(parts, { type: file.type || 'video/mp4' })
}

function describeBytes(bytes) {
  return isPrintable(bytes) ? utf8.decode(bytes).replace(/\0+/g, ' ').trim().slice(0, 500) : `(${bytes.length} bytes)`
}

function addLocation(report, iso) {
  const m = iso.match(/([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/)
  if (!m) {
    report.signal('privacy', 'Contém localização')
    return
  }
  const coords = `${(+m[1]).toFixed(6)}, ${(+m[2]).toFixed(6)}`
  report.add('GPS', 'Coordenadas', coords)
  report.signal('privacy', `Localização GPS: ${coords}`, `https://www.google.com/maps?q=${+m[1]},${+m[2]}`)
}

// ================= MP4 / MOV =================

const META_BOXES = new Set(['udta', 'meta', 'uuid', 'XMP_'])
const XMP_UUID = 'be7acfcb97a942e89c71999491e3afac'
const C2PA_UUID = 'd8fec3d61b0e483c92975828877ec481'
const FREE = new Uint8Array([0x66, 0x72, 0x65, 0x65]) // "free"

const u16 = (b, o) => (b[o] << 8) | b[o + 1]
const u32 = (b, o) => b[o] * 2 ** 24 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]
const u64 = (b, o) => u32(b, o) * 2 ** 32 + u32(b, o + 4)
const hex = (b, o, n) => [...b.subarray(o, o + n)].map((x) => x.toString(16).padStart(2, '0')).join('')

function boxHeader(b, o) {
  let size = u32(b, o)
  let hdr = 8
  if (size === 1) {
    size = u64(b, o + 8)
    hdr = 16
  }
  return { size, hdr, type: ascii(b, o + 4, 4) }
}

function* children(b, start, end) {
  let pos = start
  while (pos + 8 <= end) {
    const h = boxHeader(b, pos)
    const boxEnd = h.size === 0 ? end : pos + h.size
    if ((h.size !== 0 && h.size < h.hdr) || boxEnd > end) return
    yield { type: h.type, start: pos, data: pos + h.hdr, end: boxEnd }
    pos = boxEnd
  }
}

async function* topLevelBoxes(reader, fileSize) {
  let pos = 0
  while (pos + 8 <= fileSize) {
    const h = boxHeader(await reader.read(pos, 16), 0)
    const end = h.size === 0 ? fileSize : pos + h.size
    if (h.size !== 0 && h.size < h.hdr) return
    yield { type: h.type, start: pos, data: pos + h.hdr, end: Math.min(end, fileSize) }
    pos = end
  }
}

function metaBoxLabel(b, box) {
  if (box.type === 'udta') return 'Metadados QuickTime (udta)'
  if (box.type === 'meta') return 'Metadados (meta)'
  if (box.type === 'XMP_') return 'XMP'
  const id = hex(b, box.data, 16)
  return id === XMP_UUID ? 'XMP' : id === C2PA_UUID ? 'C2PA' : 'Caixa uuid'
}

// Datas de criação/modificação de mvhd, tkhd e mdhd (versão 0: 32 bits, versão 1: 64 bits)
function timesRange(b, box) {
  const at = box.data + 4
  return { at, len: b[box.data] === 1 ? 16 : 8 }
}

// Tabelas da trilha: handler, formato e posições das amostras
function readTrak(b, trak) {
  const info = { handler: '', format: '', tables: {}, timeBoxes: [], metaBoxes: [] }
  for (const c of children(b, trak.data, trak.end)) {
    if (c.type === 'tkhd') info.timeBoxes.push(c)
    else if (META_BOXES.has(c.type)) info.metaBoxes.push(c)
    else if (c.type !== 'mdia') continue
    for (const m of children(b, c.data, c.end)) {
      if (m.type === 'mdhd') info.timeBoxes.push(m)
      else if (m.type === 'hdlr') info.handler = ascii(b, m.data + 8, 4)
      else if (META_BOXES.has(m.type)) info.metaBoxes.push(m)
      else if (m.type !== 'minf') continue
      for (const n of children(b, m.data, m.end)) {
        if (n.type !== 'stbl') continue
        for (const s of children(b, n.data, n.end)) info.tables[s.type] = s
      }
    }
  }
  if (info.tables.stsd) info.format = ascii(b, info.tables.stsd.data + 12, 4)
  return info
}

// Intervalos [offset, tamanho] das amostras de uma trilha, agrupados por chunk
function sampleRanges(b, t) {
  const co = t.co64 ?? t.stco
  if (!t.stsz || !t.stsc || !co) return []
  const sz = t.stsz.data
  const fixedSize = u32(b, sz + 4)
  const count = u32(b, sz + 8)
  const sizeOf = (i) => fixedSize || u32(b, sz + 12 + i * 4)
  const chunks = u32(b, co.data + 4)
  const offsetOf = (i) => (t.co64 ? u64(b, co.data + 8 + i * 8) : u32(b, co.data + 8 + i * 4))
  const sc = t.stsc.data
  const entries = u32(b, sc + 4)
  const ranges = []
  let sample = 0
  for (let e = 0; e < entries; e++) {
    const first = u32(b, sc + 8 + e * 12)
    const perChunk = u32(b, sc + 12 + e * 12)
    const next = e + 1 < entries ? u32(b, sc + 8 + (e + 1) * 12) : chunks + 1
    for (let c = first; c < next && c <= chunks; c++) {
      let len = 0
      for (let k = 0; k < perChunk && sample < count; k++) len += sizeOf(sample++)
      if (len) ranges.push([offsetOf(c - 1), len])
    }
  }
  return ranges
}

function moovChildren(b) {
  const { hdr } = boxHeader(b, 0)
  return [...children(b, hdr, b.length)]
}

async function stripMp4(file) {
  const reader = new RandomAccess(file)
  const patches = []
  const removed = new Set()

  // Troca o tipo da caixa por "free" e zera o conteúdo
  const voidBox = (b, box, base) => {
    removed.add(metaBoxLabel(b, box))
    patches.push({ offset: base + box.start + 4, bytes: FREE })
    if (box.end > box.data) patches.push({ offset: base + box.data, bytes: new Uint8Array(box.end - box.data) })
  }
  const zeroTimes = (b, box, base) => {
    const { at, len } = timesRange(b, box)
    if (!b.subarray(at, at + len).some((x) => x)) return
    removed.add('Datas de criação')
    patches.push({ offset: base + at, bytes: new Uint8Array(len) })
  }

  for await (const box of topLevelBoxes(reader, file.size)) {
    if (box.type === 'moov') {
      const b = await reader.read(box.start, box.end - box.start)
      for (const c of moovChildren(b)) {
        if (c.type === 'mvhd') zeroTimes(b, c, box.start)
        else if (META_BOXES.has(c.type)) voidBox(b, c, box.start)
        else if (c.type === 'trak') {
          const trak = readTrak(b, c)
          trak.timeBoxes.forEach((t) => zeroTimes(b, t, box.start))
          trak.metaBoxes.forEach((m) => voidBox(b, m, box.start))
          // Trilhas de metadados (GPS da GoPro, sensores, dados do iPhone): zera as amostras
          if (trak.handler === 'meta') {
            for (const [offset, len] of sampleRanges(b, trak.tables)) {
              patches.push({ offset, bytes: new Uint8Array(len) })
            }
            removed.add(`Trilha de metadados (${trak.format.trim() || 'meta'})`)
          }
        }
      }
    } else if (META_BOXES.has(box.type)) {
      const head = await reader.read(box.start, box.data - box.start + 16)
      voidBox(head, { ...box, start: 0, data: box.data - box.start, end: box.end - box.start }, box.start)
    } else if ((box.type === 'free' || box.type === 'skip') && box.end - box.data <= 64 << 20) {
      // Espaço livre pode guardar restos de metadados antigos
      patches.push({ offset: box.data, bytes: new Uint8Array(box.end - box.data) })
    }
  }

  return { blob: assemble(file, patches), removed: [...removed] }
}

const MP4_TAGS = {
  '©xyz': 'Localização (ISO 6709)',
  '©mak': 'Fabricante da câmera',
  '©mod': 'Modelo da câmera',
  '©swr': 'Software',
  '©too': 'Software (codificador)',
  '©enc': 'Codificado por',
  '©day': 'Data de criação',
  '©nam': 'Título',
  '©ART': 'Autor',
  '©aut': 'Autor',
  '©cmt': 'Comentário',
  '©des': 'Descrição',
  '©inf': 'Informações',
  '©cpy': 'Copyright',
  '©alb': 'Álbum',
  cprt: 'Copyright',
  auth: 'Autor',
  titl: 'Título',
  dscp: 'Descrição',
  perf: 'Autor',
  kywd: 'Palavras-chave',
  albm: 'Álbum',
  date: 'Data de criação',
  desc: 'Descrição',
  ldes: 'Descrição',
  'com.apple.quicktime.location.ISO6709': 'Localização (ISO 6709)',
  'com.apple.quicktime.location.accuracy.horizontal': 'Precisão da localização',
  'com.apple.quicktime.make': 'Fabricante da câmera',
  'com.apple.quicktime.model': 'Modelo da câmera',
  'com.apple.quicktime.software': 'Software',
  'com.apple.quicktime.creationdate': 'Data de criação',
  'com.apple.quicktime.author': 'Autor',
  'com.apple.quicktime.comment': 'Comentário',
  'com.apple.quicktime.description': 'Descrição',
  'com.apple.quicktime.title': 'Título',
  'com.apple.quicktime.content.identifier': 'ID único da imagem',
  'com.apple.quicktime.camera.lens_model': 'Modelo da lente',
  'com.android.version': 'Versão do Android',
  'com.android.manufacturer': 'Fabricante da câmera',
  'com.android.model': 'Modelo da câmera',
}

function addTag(report, rawName, value) {
  const name = MP4_TAGS[rawName] ?? rawName
  report.add('Metadados do vídeo', name, value)
  if (name === 'Localização (ISO 6709)') addLocation(report, value)
}

// Valor de uma caixa "data" (estilo iTunes/QuickTime)
function dataValue(b, d) {
  const type = u32(b, d.data) & 0xffffff
  const v = b.subarray(d.data + 8, d.end)
  const view = new DataView(v.buffer, v.byteOffset, v.byteLength)
  if (type === 1) return utf8.decode(v)
  if (type === 2) return new TextDecoder('utf-16be').decode(v)
  if ((type === 21 || type === 22) && v.length <= 4) {
    let n = 0
    for (const x of v) n = n * 256 + x
    return String(type === 21 && v.length && v[0] & 0x80 ? n - 2 ** (8 * v.length) : n)
  }
  if (type === 23 && v.length === 4) return String(view.getFloat32(0))
  if (type === 24 && v.length === 8) return String(view.getFloat64(0))
  if (type === 13 || type === 14 || type === 27) return `(imagem, ${v.length} bytes)`
  return describeBytes(v)
}

// Texto de uma caixa ©xxx: caixa "data" ou strings QuickTime (tamanho + idioma + texto)
function qtString(b, box) {
  const data = [...children(b, box.data, box.end)].find((c) => c.type === 'data')
  if (data) return dataValue(b, data)
  const parts = []
  let pos = box.data
  while (pos + 4 <= box.end) {
    const len = u16(b, pos)
    parts.push(utf8.decode(b.subarray(pos + 4, pos + 4 + len)).replace(/\0+$/, ''))
    pos += 4 + len
  }
  return parts.join(' / ')
}

// Caixas de texto do 3GPP (auth, titl, dscp, cprt...): versão, idioma e texto
const THREE_GPP_TEXT = new Set(['auth', 'titl', 'dscp', 'cprt', 'perf', 'gnre', 'albm', 'kywd'])

function threeGppString(b, box) {
  const raw = b.subarray(box.data + 6, box.end)
  const text = raw[0] === 0xfe && raw[1] === 0xff ? new TextDecoder('utf-16be').decode(raw.subarray(2)) : utf8.decode(raw)
  return text.replace(/\0[\s\S]*$/, '')
}

// Localização do 3GPP: nome, papel e longitude/latitude/altitude em ponto fixo 16.16
function threeGppLocation(b, box) {
  let p = box.data + 6
  while (p < box.end && b[p] !== 0) p++
  const view = new DataView(b.buffer, b.byteOffset + p + 2, 12)
  const lon = view.getInt32(0) / 65536
  const lat = view.getInt32(4) / 65536
  const alt = view.getInt32(8) / 65536
  return `${lat >= 0 ? '+' : ''}${lat.toFixed(4)}${lon >= 0 ? '+' : ''}${lon.toFixed(4)}+${alt.toFixed(1)}/`
}

function inspectMeta(b, box, report) {
  let start = box.data
  // O "meta" do ISO é FullBox (4 bytes de versão); o do QuickTime não
  if (ascii(b, start + 4, 4) !== 'hdlr') start += 4
  const keys = []
  for (const c of children(b, start, box.end)) {
    if (c.type === 'keys') {
      let p = c.data + 8
      for (let i = 0; i < u32(b, c.data + 4) && p + 8 <= c.end; i++) {
        const size = u32(b, p)
        keys.push(utf8.decode(b.subarray(p + 8, p + size)))
        p += size
      }
    } else if (c.type === 'ilst') {
      for (const item of children(b, c.data, c.end)) {
        const index = u32(b, item.start + 4)
        const name = index >= 1 && index <= keys.length ? keys[index - 1] : item.type
        const data = [...children(b, item.data, item.end)].find((x) => x.type === 'data')
        addTag(report, name, data ? dataValue(b, data) : describeBytes(b.subarray(item.data, item.end)))
      }
    } else if (c.type === 'xml ') {
      parseXmp(utf8.decode(b.subarray(c.data + 4, c.end)), report)
    }
  }
}

function inspectMetaBox(b, box, report) {
  if (box.type === 'meta') return inspectMeta(b, box, report)
  if (box.type === 'XMP_') return parseXmp(utf8.decode(b.subarray(box.data, box.end)), report)
  if (box.type === 'uuid') {
    const id = hex(b, box.data, 16)
    const payload = b.subarray(box.data + 16, box.end)
    if (id === XMP_UUID) parseXmp(utf8.decode(payload), report)
    else if (id === C2PA_UUID) parseC2pa(payload, report)
    else report.add('Vídeo', `Caixa uuid ${id}`, describeBytes(payload))
    return
  }
  // udta
  for (const c of children(b, box.data, box.end)) {
    if (c.type === 'meta' || c.type === 'XMP_') inspectMetaBox(b, c, report)
    else if (c.type.startsWith('©')) addTag(report, c.type, qtString(b, c))
    else if (THREE_GPP_TEXT.has(c.type)) addTag(report, c.type, threeGppString(b, c))
    else if (c.type === 'loci' && c.end - c.data >= 20) addTag(report, '©xyz', threeGppLocation(b, c))
    else if (MP4_TAGS[c.type]) addTag(report, c.type, describeBytes(b.subarray(c.data, c.end)))
    else report.add('Metadados do vídeo', `Caixa ${c.type}`, describeBytes(b.subarray(c.data, c.end)))
  }
}

const mp4Date = (seconds) =>
  new Date(Date.UTC(1904, 0, 1) + seconds * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'

async function inspectMp4(file, report) {
  const reader = new RandomAccess(file)
  const dates = new Set()
  const metaTracks = []

  const readTimes = (b, box) => {
    const { at, len } = timesRange(b, box)
    const read = len === 16 ? u64 : u32
    for (const o of [at, at + len / 2]) if (read(b, o)) dates.add(mp4Date(read(b, o)))
  }

  for await (const box of topLevelBoxes(reader, file.size)) {
    if (box.type === 'ftyp') {
      report.add('Vídeo', 'Formato', ascii(await reader.read(box.data, 4), 0, 4).trim(), true)
    } else if (box.type === 'moov') {
      const b = await reader.read(box.start, box.end - box.start)
      for (const c of moovChildren(b)) {
        if (c.type === 'mvhd') readTimes(b, c)
        else if (META_BOXES.has(c.type)) inspectMetaBox(b, c, report)
        else if (c.type === 'trak') {
          const trak = readTrak(b, c)
          trak.timeBoxes.forEach((t) => readTimes(b, t))
          trak.metaBoxes.forEach((m) => inspectMetaBox(b, m, report))
          if (trak.handler === 'meta') metaTracks.push({ format: trak.format.trim(), ranges: sampleRanges(b, trak.tables) })
        }
      }
    } else if (META_BOXES.has(box.type) && box.end - box.start <= 64 << 20) {
      const b = await reader.read(box.start, box.end - box.start)
      inspectMetaBox(b, { ...box, start: 0, data: box.data - box.start, end: b.length }, report)
    } else if ((box.type === 'free' || box.type === 'skip') && box.end - box.data <= 16 << 20) {
      const b = await reader.read(box.data, box.end - box.data)
      if (b.some((x) => x)) report.add('Vídeo', 'Espaço livre com dados residuais', describeBytes(b))
    }
  }

  for (const d of dates) report.add('Datas', 'Data de criação/modificação', d)

  // Verifica se as amostras das trilhas de metadados ainda têm conteúdo
  for (const track of metaTracks) {
    const total = track.ranges.reduce((s, [, len]) => s + len, 0)
    let hasData = false
    let checked = 0
    for (const [offset, len] of track.ranges) {
      if (hasData || checked > 1 << 20) break
      hasData = (await reader.read(offset, len)).some((x) => x)
      checked += len
    }
    const name = `Trilha de metadados (${track.format || 'meta'})`
    if (hasData) report.add('Trilhas', name, `${track.ranges.length} bloco(s), ${total} bytes de dados de sensores/GPS`)
    else report.add('Trilhas', `${name} zerada`, 'sem conteúdo', true)
  }
}

// ================= WebM / MKV =================

const EBML = {
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  info: 0x1549a966,
  tracks: 0x1654ae6b,
  cluster: 0x1f43b675,
  cues: 0x1c53bb6b,
  tags: 0x1254c367,
  attachments: 0x1941a469,
  chapters: 0x1043a770,
  title: 0x7ba9,
  muxingApp: 0x4d80,
  writingApp: 0x5741,
  dateUtc: 0x4461,
  tag: 0x7373,
  simpleTag: 0x67c8,
  tagName: 0x45a3,
  tagString: 0x4487,
  attachedFile: 0x61a7,
  fileName: 0x466e,
  fileMimeType: 0x4660,
}

const LEVEL1 = new Set([
  EBML.seekHead, EBML.info, EBML.tracks, EBML.cluster, EBML.cues, EBML.tags, EBML.attachments, EBML.chapters,
])

const INFO_META = {
  [EBML.title]: 'Título',
  [EBML.muxingApp]: 'Software (multiplexador)',
  [EBML.writingApp]: 'Software (gravação)',
  [EBML.dateUtc]: 'Data de criação',
}

// Inteiro de tamanho variável do EBML; com keepMarker, lê um ID
function vint(b, o, keepMarker) {
  const first = b[o]
  let len = 1
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++
  if (len > 8 || o + len > b.length) return null
  let value = keepMarker ? first : first & (0xff >> len)
  let allOnes = value === 0xff >> len
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[o + i]
    if (b[o + i] !== 0xff) allOnes = false
  }
  return { len, value, unknown: !keepMarker && allOnes }
}

function elementHeader(b, o) {
  const id = vint(b, o, true)
  const size = id && vint(b, o + id.len, false)
  if (!size) return null
  return { id: id.value, hdr: id.len + size.len, size: size.unknown ? null : size.value }
}

function* ebmlChildren(b, start, end) {
  let pos = start
  while (pos < end) {
    const e = elementHeader(b, pos)
    if (!e || e.size === null) return
    yield { id: e.id, start: pos, data: pos + e.hdr, end: pos + e.hdr + e.size }
    pos += e.hdr + e.size
  }
}

// Fim de um elemento de tamanho desconhecido (ex.: Cluster do MediaRecorder)
async function skipUnknown(reader, pos, end) {
  while (pos < end) {
    const e = elementHeader(await reader.read(pos, 16), 0)
    if (!e || e.size === null) return end
    if (LEVEL1.has(e.id)) return pos
    pos += e.hdr + e.size
  }
  return end
}

async function* segmentChildren(reader, fileSize) {
  const header = elementHeader(await reader.read(0, 16), 0)
  let pos = header.hdr + header.size
  const segment = elementHeader(await reader.read(pos, 16), 0)
  if (!segment || segment.id !== EBML.segment) return
  const end = segment.size === null ? fileSize : Math.min(pos + segment.hdr + segment.size, fileSize)
  pos += segment.hdr
  while (pos < end) {
    const e = elementHeader(await reader.read(pos, 16), 0)
    if (!e) return
    const elEnd = e.size === null ? await skipUnknown(reader, pos + e.hdr, end) : pos + e.hdr + e.size
    yield { id: e.id, start: pos, data: pos + e.hdr, end: Math.min(elEnd, end) }
    pos = elEnd
  }
}

// Elemento Void (0xEC) do mesmo tamanho, para não deslocar nada no arquivo
function voidElement(len) {
  const out = new Uint8Array(len)
  out[0] = 0xec
  if (len >= 9) {
    out[1] = 0x01
    let v = len - 9
    for (let i = 8; i >= 2; i--) {
      out[i] = v % 256
      v = Math.floor(v / 256)
    }
  } else {
    out[1] = 0x80 | (len - 2)
  }
  return out
}

async function stripMatroska(file) {
  const reader = new RandomAccess(file)
  const patches = []
  const removed = new Set()
  const voidIt = (start, end, label) => {
    patches.push({ offset: start, bytes: voidElement(end - start) })
    removed.add(label)
  }

  for await (const el of segmentChildren(reader, file.size)) {
    if (el.id === EBML.tags) voidIt(el.start, el.end, 'Tags')
    else if (el.id === EBML.attachments) voidIt(el.start, el.end, 'Anexos')
    else if (el.id === EBML.info) {
      const b = await reader.read(el.start, el.end - el.start)
      for (const c of ebmlChildren(b, el.data - el.start, b.length)) {
        if (INFO_META[c.id]) voidIt(el.start + c.start, el.start + c.end, INFO_META[c.id])
      }
    }
  }

  return { blob: assemble(file, patches), removed: [...removed] }
}

// Nomes de tags oficiais do Matroska
const MKV_TAGS = {
  TITLE: '©nam',
  ARTIST: '©ART',
  DIRECTOR: '©ART',
  COMMENT: '©cmt',
  DESCRIPTION: '©des',
  COPYRIGHT: '©cpy',
  ENCODER: '©too',
  ENCODED_BY: '©enc',
  DATE_RECORDED: '©day',
  DATE_ENCODED: '©day',
  RECORDING_LOCATION: '©xyz',
  LOCATION: '©xyz',
}

function walkTags(b, start, end, report) {
  for (const c of ebmlChildren(b, start, end)) {
    if (c.id === EBML.tag) walkTags(b, c.data, c.end, report)
    else if (c.id === EBML.simpleTag) {
      let name = ''
      let value = ''
      for (const s of ebmlChildren(b, c.data, c.end)) {
        if (s.id === EBML.tagName) name = utf8.decode(b.subarray(s.data, s.end))
        else if (s.id === EBML.tagString) value = utf8.decode(b.subarray(s.data, s.end))
      }
      addTag(report, MKV_TAGS[name] ?? name, value)
      walkTags(b, c.data, c.end, report) // SimpleTag pode ter SimpleTags aninhadas
    }
  }
}

async function inspectMatroska(file, report) {
  const reader = new RandomAccess(file)
  for await (const el of segmentChildren(reader, file.size)) {
    const len = el.end - el.start
    if (el.id === EBML.info) {
      const b = await reader.read(el.start, len)
      for (const c of ebmlChildren(b, el.data - el.start, b.length)) {
        const name = INFO_META[c.id]
        if (!name) continue
        const raw = b.subarray(c.data, c.end)
        if (c.id === EBML.dateUtc && raw.length === 8) {
          const ns = new DataView(raw.buffer, raw.byteOffset, 8).getBigInt64(0)
          const date = new Date(Date.UTC(2001, 0, 1) + Number(ns / 1000000n))
          report.add('WebM/MKV', name, date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC')
        } else {
          report.add('WebM/MKV', name, utf8.decode(raw))
        }
      }
    } else if (el.id === EBML.tags && len <= 64 << 20) {
      const b = await reader.read(el.start, len)
      walkTags(b, el.data - el.start, b.length, report)
    } else if (el.id === EBML.attachments) {
      if (len > 64 << 20) {
        report.add('Anexos', 'Arquivos anexados', `${len} bytes`)
        continue
      }
      const b = await reader.read(el.start, len)
      for (const f of ebmlChildren(b, el.data - el.start, b.length)) {
        if (f.id !== EBML.attachedFile) continue
        let name = 'Arquivo'
        let mime = ''
        for (const c of ebmlChildren(b, f.data, f.end)) {
          if (c.id === EBML.fileName) name = utf8.decode(b.subarray(c.data, c.end))
          else if (c.id === EBML.fileMimeType) mime = utf8.decode(b.subarray(c.data, c.end))
        }
        report.add('Anexos', name, `${mime} (${f.end - f.start} bytes)`)
      }
    }
  }
}

// ================= API =================

export async function stripVideo(file, format) {
  return format === 'matroska' ? stripMatroska(file) : stripMp4(file)
}

export async function inspectVideo(file, format, report) {
  return format === 'matroska' ? inspectMatroska(file, report) : inspectMp4(file, report)
}
