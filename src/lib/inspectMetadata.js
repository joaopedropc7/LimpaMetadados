// Lê os metadados de uma imagem e aponta o que pode identificar o autor,
// o aparelho, o local ou indicar que ela foi gerada/editada por IA.

import {
  ascii,
  concat,
  detectFormat,
  gifBlocks,
  gifSubBlockData,
  jpegSegments,
  pngChunks,
  webpChunks,
} from './imageFormat'
import { detectVideoFormat, inspectVideo } from './video'

const utf8 = new TextDecoder('utf-8')
const latin1 = new TextDecoder('latin1')
const clean = (s) => s.replace(/\0+$/g, '').trim()

// ---------- EXIF (TIFF) ----------

const T = true // marca tags puramente técnicas (não identificam nada)

const EXIF_TAGS = {
  0x010e: ['Descrição da imagem'],
  0x010f: ['Fabricante da câmera'],
  0x0110: ['Modelo da câmera'],
  0x0112: ['Orientação', T],
  0x011a: ['Resolução X', T],
  0x011b: ['Resolução Y', T],
  0x0128: ['Unidade de resolução', T],
  0x0131: ['Software'],
  0x0132: ['Data de modificação'],
  0x013b: ['Autor'],
  0x0213: ['Posicionamento YCbCr', T],
  0x8298: ['Copyright'],
  0x829a: ['Tempo de exposição'],
  0x829d: ['Abertura (f)'],
  0x8822: ['Programa de exposição'],
  0x8827: ['ISO'],
  0x9000: ['Versão EXIF', T],
  0x9003: ['Data original'],
  0x9004: ['Data de digitalização'],
  0x9010: ['Fuso horário'],
  0x9011: ['Fuso horário (original)'],
  0x9012: ['Fuso horário (digitalização)'],
  0x9209: ['Flash'],
  0x920a: ['Distância focal'],
  0x927c: ['MakerNote (dados do fabricante)'],
  0x9286: ['Comentário do usuário'],
  0x9290: ['Subsegundos'],
  0x9291: ['Subsegundos (original)'],
  0x9292: ['Subsegundos (digitalização)'],
  0x9c9b: ['Título (Windows)'],
  0x9c9c: ['Comentário (Windows)'],
  0x9c9d: ['Autor (Windows)'],
  0x9c9e: ['Palavras-chave (Windows)'],
  0x9c9f: ['Assunto (Windows)'],
  0xa000: ['Versão FlashPix', T],
  0xa001: ['Espaço de cor', T],
  0xa002: ['Largura', T],
  0xa003: ['Altura', T],
  0xa420: ['ID único da imagem'],
  0xa430: ['Dono da câmera'],
  0xa431: ['Nº de série da câmera'],
  0xa432: ['Especificação da lente'],
  0xa433: ['Fabricante da lente'],
  0xa434: ['Modelo da lente'],
  0xa435: ['Nº de série da lente'],
}

const GPS_TAGS = {
  0x00: 'Versão GPS',
  0x01: 'Ref. latitude',
  0x02: 'Latitude',
  0x03: 'Ref. longitude',
  0x04: 'Longitude',
  0x05: 'Ref. altitude',
  0x06: 'Altitude',
  0x07: 'Hora GPS',
  0x10: 'Ref. direção',
  0x11: 'Direção da imagem',
  0x12: 'Datum',
  0x1d: 'Data GPS',
}

// Ponteiros e offsets que não são dados em si
const POINTER_TAGS = new Set([0x8769, 0x8825, 0xa005, 0x0201, 0x0202])
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8 }

export function isPrintable(bytes) {
  if (bytes.length === 0) return false
  let ok = 0
  for (const b of bytes) if ((b >= 0x20 && b < 0x7f) || b === 0x0a || b === 0x0d || b === 0x09 || b >= 0xc0) ok++
  return ok / bytes.length > 0.9
}

function parseTiff(bytes, tiff, end, report) {
  const little = bytes[tiff] === 0x49
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const inRange = (o, n) => o >= tiff && o + n <= end
  const u16 = (o) => (inRange(o, 2) ? view.getUint16(o, little) : 0)
  const u32 = (o) => (inRange(o, 4) ? view.getUint32(o, little) : 0)
  const visited = new Set()

  function readValue(tag, type, count, off) {
    const raw = bytes.subarray(off, off + count * (TYPE_SIZE[type] ?? 1))
    if (type === 2) return clean(utf8.decode(raw))
    if (tag >= 0x9c9b && tag <= 0x9c9f) return clean(new TextDecoder('utf-16le').decode(raw))
    if (tag === 0x9286) {
      const charset = ascii(raw, 0, 8)
      const text = raw.subarray(8)
      return clean(charset.startsWith('UNICODE') ? new TextDecoder(little ? 'utf-16le' : 'utf-16be').decode(text) : utf8.decode(text))
    }
    if (type === 1 || type === 6 || type === 7) {
      return isPrintable(raw) ? clean(utf8.decode(raw)) : `(${raw.length} bytes)`
    }
    const values = []
    for (let i = 0; i < Math.min(count, 16); i++) {
      if (type === 3) values.push(u16(off + i * 2))
      else if (type === 8) values.push(view.getInt16(off + i * 2, little))
      else if (type === 4) values.push(u32(off + i * 4))
      else if (type === 9) values.push(view.getInt32(off + i * 4, little))
      else if (type === 5 || type === 10) {
        const n = type === 5 ? u32(off + i * 8) : view.getInt32(off + i * 8, little)
        const d = type === 5 ? u32(off + i * 8 + 4) : view.getInt32(off + i * 8 + 4, little)
        values.push(d ? Math.round((n / d) * 10000) / 10000 : 0)
      }
    }
    return values
  }

  function readIfd(offset, group) {
    const ifd = tiff + offset
    if (!offset || visited.has(ifd) || !inRange(ifd, 2)) return { values: {}, next: 0 }
    visited.add(ifd)
    const values = {}
    const count = u16(ifd)
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12
      if (!inRange(entry, 12)) break
      const tag = u16(entry)
      const type = u16(entry + 2)
      const n = u32(entry + 4)
      const size = (TYPE_SIZE[type] ?? 1) * n
      const off = size <= 4 ? entry + 8 : tiff + u32(entry + 8)
      if (!inRange(off, size)) continue
      if (POINTER_TAGS.has(tag)) {
        values[tag] = u32(entry + 8)
        continue
      }
      const value = readValue(tag, type, n, off)
      values[tag] = value
      const shown = Array.isArray(value) ? value.join(', ') : value
      if (group === 'GPS') {
        report.add('GPS', GPS_TAGS[tag] ?? `Tag GPS ${tag}`, shown)
      } else {
        const [name, technical] = EXIF_TAGS[tag] ?? [`Tag 0x${tag.toString(16).padStart(4, '0')}`]
        report.add(group, name, tag === 0x927c ? `(${size} bytes)` : shown, technical)
      }
    }
    return { values, next: u32(ifd + 2 + count * 12) }
  }

  const ifd0 = readIfd(u32(tiff + 4), 'EXIF')
  if (ifd0.values[0x8769]) readIfd(ifd0.values[0x8769], 'EXIF')
  if (ifd0.next) {
    readIfd(ifd0.next, 'Miniatura')
    report.signal('privacy', 'Miniatura embutida no EXIF (pode mostrar a foto original, antes de recortes)')
  }
  if (ifd0.values[0x8825]) {
    const gps = readIfd(ifd0.values[0x8825], 'GPS').values
    const toDecimal = (dms, ref) =>
      Array.isArray(dms) && dms.length === 3 ? (dms[0] + dms[1] / 60 + dms[2] / 3600) * (/[SW]/.test(ref) ? -1 : 1) : null
    const lat = toDecimal(gps[2], gps[1])
    const lon = toDecimal(gps[4], gps[3])
    if (lat !== null && lon !== null && (lat || lon)) {
      const coords = `${lat.toFixed(6)}, ${lon.toFixed(6)}`
      report.add('GPS', 'Coordenadas', coords)
      report.signal('privacy', `Localização GPS: ${coords}`, `https://www.google.com/maps?q=${lat},${lon}`)
    } else if (Object.keys(gps).length) {
      report.signal('privacy', 'Contém dados de GPS')
    }
  }
}

// ---------- XMP ----------

export function parseXmp(xml, report) {
  report.add('XMP', 'Pacote XMP completo', xml.trim())
  const seen = new Set()
  const push = (key, value) => {
    value = value.trim()
    if (!value || key.startsWith('xmlns') || key.startsWith('rdf:') || key.startsWith('x:')) return
    const id = key + value
    if (seen.has(id)) return
    seen.add(id)
    report.add('XMP', key, value)
  }
  for (const m of xml.matchAll(/([\w-]+:[\w-]+)="([^"]*)"/g)) push(m[1], m[2])
  for (const m of xml.matchAll(/<([\w-]+:[\w-]+)(?:\s[^>]*)?>([^<]+)<\/\1>/g)) push(m[1], m[2])
  // Valores em listas (dc:creator, dc:subject...)
  for (const m of xml.matchAll(/<([\w-]+:[\w-]+)(?:\s[^>]*)?>\s*<rdf:(?:Seq|Bag|Alt)>([\s\S]*?)<\/rdf:(?:Seq|Bag|Alt)>/g)) {
    const items = [...m[2].matchAll(/<rdf:li[^>]*>([^<]*)<\/rdf:li>/g)].map((x) => x[1].trim()).filter(Boolean)
    if (items.length) push(m[1], items.join(', '))
  }
}

// ---------- IPTC (Photoshop APP13) ----------

const IPTC_TAGS = {
  5: 'Título',
  25: 'Palavras-chave',
  55: 'Data de criação',
  60: 'Hora de criação',
  80: 'Autor',
  85: 'Cargo do autor',
  90: 'Cidade',
  92: 'Bairro',
  95: 'Estado',
  101: 'País',
  105: 'Manchete',
  110: 'Crédito',
  115: 'Fonte',
  116: 'Copyright',
  118: 'Contato',
  120: 'Legenda',
  122: 'Redator da legenda',
}

function parsePhotoshop(bytes, start, end, report) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = start + 14 // "Photoshop 3.0\0"
  let resources = 0
  while (pos + 12 <= end && ascii(bytes, pos, 4) === '8BIM') {
    const id = view.getUint16(pos + 4)
    const nameLen = bytes[pos + 6]
    pos += 6 + (nameLen + 1 + ((nameLen + 1) & 1))
    const size = view.getUint32(pos)
    const data = pos + 4
    pos = data + size + (size & 1)
    resources++
    if (id !== 0x0404) continue
    // Registros IPTC-IIM
    const values = {}
    let p = data
    while (p + 5 <= data + size && bytes[p] === 0x1c) {
      const record = bytes[p + 1]
      const dataset = bytes[p + 2]
      const len = view.getUint16(p + 3)
      if (len & 0x8000) break
      if (record === 2 && dataset !== 0) {
        const name = IPTC_TAGS[dataset] ?? `IPTC 2:${dataset}`
        values[name] = values[name] ? `${values[name]}, ` : ''
        values[name] += clean(utf8.decode(bytes.subarray(p + 5, p + 5 + len)))
      }
      p += 5 + len
    }
    for (const [k, v] of Object.entries(values)) report.add('IPTC', k, v)
  }
  if (resources) report.add('Photoshop', 'Recursos do Photoshop', `${resources} bloco(s)`)
}

// ---------- C2PA ----------

export function parseC2pa(raw, report) {
  // O manifesto é binário (JUMBF/CBOR); extraímos os textos legíveis
  const strings = [...new Set(latin1.decode(raw).match(/[\x20-\x7e]{5,}/g) ?? [])]
  report.c2pa = true
  report.scanText.push(strings.join('\n'))
  report.add('C2PA', 'Manifesto Content Credentials', `${raw.length} bytes`)
  const interesting = strings.filter((s) =>
    /generator|softwareAgent|digitalSourceType|c2pa\.(actions|created|edited|opened)|name|Algorithmic|\bAI\b/i.test(s),
  )
  if (interesting.length) report.add('C2PA', 'Textos do manifesto', interesting.slice(0, 40).join('\n'))
}

// ---------- Por formato ----------

function inspectJpeg(bytes, report) {
  const app11 = []
  for (const { marker, end, data } of jpegSegments(bytes)) {
    if (marker === 0xe1) {
      const header = ascii(bytes, data, 40)
      if (header.startsWith('Exif')) parseTiff(bytes, data + 6, end, report)
      else if (header.startsWith('http://ns.adobe.com/xap/1.0/')) parseXmp(utf8.decode(bytes.subarray(data + 29, end)), report)
      else if (header.startsWith('http://ns.adobe.com/xmp/extension/'))
        parseXmp(utf8.decode(bytes.subarray(data + 75, end)), report)
      else report.add('APP1', 'Dados desconhecidos', `${end - data} bytes`)
    } else if (marker === 0xe0) {
      const id = ascii(bytes, data, 5)
      if (id === 'JFIF\0') report.add('JPEG', 'Cabeçalho JFIF', 'presente', T)
      else report.add('JPEG', id.startsWith('JFXX') ? 'Miniatura JFXX' : 'APP0', `${end - data} bytes`)
    } else if (marker === 0xe2) {
      if (ascii(bytes, data, 11) === 'ICC_PROFILE') report.add('Cor', 'Perfil de cor ICC', 'presente', T)
      else report.add('APP2', ascii(bytes, data, 4).replace(/\0/g, '') || 'APP2', `${end - data} bytes`)
    } else if (marker === 0xed) {
      if (ascii(bytes, data, 13) === 'Photoshop 3.0') parsePhotoshop(bytes, data, end, report)
      else report.add('APP13', 'Dados desconhecidos', `${end - data} bytes`)
    } else if (marker === 0xeb) {
      app11.push(bytes.subarray(data, end))
    } else if (marker === 0xee) {
      if (ascii(bytes, data, 5) === 'Adobe') report.add('JPEG', 'Segmento Adobe', 'presente', T)
      else report.add('APP14', 'Dados desconhecidos', `${end - data} bytes`)
    } else if (marker >= 0xe3 && marker <= 0xef) {
      const id = ascii(bytes, data, 16).split('\0')[0].replace(/[^\x20-\x7e]/g, '')
      report.add(`APP${marker - 0xe0}`, id || 'Dados de aplicativo', `${end - data} bytes`)
    } else if (marker === 0xfe) {
      report.add('Comentário', 'Comentário JPEG', clean(utf8.decode(bytes.subarray(data, end))))
    }
  }
  if (app11.length) parseC2pa(concat(app11), report)
}

async function inflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const PNG_TECHNICAL = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'pHYs', 'bKGD',
  'cICP', 'mDCV', 'cLLI', 'acTL', 'fcTL', 'fdAT',
])

async function addPngText(keyword, text, report) {
  if (keyword === 'XML:com.adobe.xmp') parseXmp(text, report)
  else report.add('PNG texto', keyword, clean(text))
}

async function inspectPng(bytes, report) {
  for (const { type, start, end, data, len } of pngChunks(bytes)) {
    const body = bytes.subarray(data, data + len)
    if (PNG_TECHNICAL.has(type)) continue
    if (type === 'iCCP') {
      report.add('Cor', 'Perfil de cor ICC', 'presente', T)
    } else if (type === 'tEXt') {
      const sep = body.indexOf(0)
      await addPngText(latin1.decode(body.subarray(0, sep)), latin1.decode(body.subarray(sep + 1)), report)
    } else if (type === 'zTXt') {
      const sep = body.indexOf(0)
      const text = latin1.decode(await inflate(body.subarray(sep + 2)).catch(() => new Uint8Array()))
      await addPngText(latin1.decode(body.subarray(0, sep)), text, report)
    } else if (type === 'iTXt') {
      const sep = body.indexOf(0)
      const compressed = body[sep + 1] === 1
      let p = body.indexOf(0, sep + 3) // fim do idioma
      p = body.indexOf(0, p + 1) // fim da palavra-chave traduzida
      let raw = body.subarray(p + 1)
      if (compressed) raw = await inflate(raw).catch(() => new Uint8Array())
      await addPngText(utf8.decode(body.subarray(0, sep)), utf8.decode(raw), report)
    } else if (type === 'eXIf') {
      parseTiff(bytes, data, data + len, report)
    } else if (type === 'tIME') {
      const v = new DataView(body.buffer, body.byteOffset, body.byteLength)
      const pad = (n) => String(n).padStart(2, '0')
      report.add('PNG', 'Data de modificação', `${v.getUint16(0)}-${pad(body[2])}-${pad(body[3])} ${pad(body[4])}:${pad(body[5])}:${pad(body[6])}`)
    } else if (type === 'caBX') {
      parseC2pa(body, report)
    } else {
      report.add('PNG', `Chunk ${type}`, `${end - start} bytes`)
    }
  }
}

const WEBP_TECHNICAL = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF'])

function inspectWebp(bytes, report) {
  for (const { type, data, len } of webpChunks(bytes)) {
    if (WEBP_TECHNICAL.has(type)) continue
    if (type === 'ICCP') report.add('Cor', 'Perfil de cor ICC', 'presente', T)
    else if (type === 'EXIF') {
      const offset = ascii(bytes, data, 4) === 'Exif' ? 6 : 0
      parseTiff(bytes, data + offset, data + len, report)
    } else if (type === 'XMP ') parseXmp(utf8.decode(bytes.subarray(data, data + len)), report)
    else if (type === 'C2PA') parseC2pa(bytes.subarray(data, data + len), report)
    else report.add('WebP', `Chunk ${type.trim()}`, `${len} bytes`)
  }
}

function inspectGif(bytes, report) {
  for (const { kind, label, start, end } of gifBlocks(bytes)) {
    if (kind !== 'ext') continue
    if (label === 0xfe) {
      report.add('Comentário', 'Comentário GIF', clean(latin1.decode(gifSubBlockData(bytes, start + 2))))
    } else if (label === 0xff) {
      const id = ascii(bytes, start + 3, 11)
      if (id.startsWith('NETSCAPE') || id.startsWith('ANIMEXTS')) {
        report.add('GIF', 'Loop da animação', 'presente', T)
      } else if (id.startsWith('XMP')) {
        // O XMP do GIF não segue o formato de sub-blocos; lemos o texto bruto
        const text = utf8.decode(bytes.subarray(start + 14, end))
        const xml = text.slice(text.indexOf('<'), text.lastIndexOf('>') + 1)
        parseXmp(xml, report)
      } else {
        report.add('GIF', `Aplicativo ${id.replace(/[^\x20-\x7e]/g, '')}`, `${end - start} bytes`)
      }
    }
  }
}

// ---------- Detecção de IA e privacidade ----------

const AI_SOURCE_RULES = [
  [/compositeWithTrainedAlgorithmicMedia/, 'IPTC DigitalSourceType: imagem composta/editada com IA'],
  [/\btrainedAlgorithmicMedia/, 'IPTC DigitalSourceType: imagem gerada por IA'],
  [/compositeSynthetic|algorithmicallyEnhanced/, 'IPTC DigitalSourceType: imagem sintética ou aprimorada por algoritmo'],
  [/Steps: \d+[\s\S]{0,200}Sampler:/, 'Parâmetros de geração do Stable Diffusion (AUTOMATIC1111/Forge)'],
  [/"class_type"\s*:|ComfyUI/, 'Fluxo de trabalho do ComfyUI'],
  [/c2pa\.ai[_.]|ai_generat|aiGenerated|"ai_generated"/i, 'Marcação de conteúdo gerado por IA'],
]

const AI_GENERATORS = [
  [/\bmidjourney\b/i, 'Midjourney'],
  [/\bdall[-·\s]?e\b/i, 'DALL·E'],
  [/\bopenai\b/i, 'OpenAI'],
  [/\bchatgpt\b|\bgpt-4o\b|\bgpt-image/i, 'ChatGPT'],
  [/\bsora\b/i, 'Sora'],
  [/\bstable[\s-]?diffusion\b|\bsdxl\b|\bstability\.?ai\b/i, 'Stable Diffusion'],
  [/\bnovelai\b/i, 'NovelAI'],
  [/\bfirefly\b/i, 'Adobe Firefly'],
  [/\bimagen\b|\bgoogle ai\b|\bgemini\b|\bnano[\s-]?banana\b/i, 'Google (Imagen/Gemini)'],
  [/\bleonardo\.?ai\b/i, 'Leonardo.Ai'],
  [/\bideogram\b/i, 'Ideogram'],
  [/\bflux\.?1\b|\bblack forest labs\b/i, 'FLUX'],
  [/\binvokeai\b/i, 'InvokeAI'],
  [/\bdreamstudio\b/i, 'DreamStudio'],
  [/\bnightcafe\b/i, 'NightCafe'],
  [/\bplayground\s?ai\b|\bplaygroundai\b/i, 'Playground AI'],
  [/\bbing image creator\b|\bmicrosoft designer\b|\bcopilot\b/i, 'Microsoft (Bing/Designer/Copilot)'],
  [/\bgrok\b|\bx\.ai\b/i, 'Grok (xAI)'],
  [/\brunway(ml)?\b/i, 'Runway'],
  [/\bkrea\.?ai\b/i, 'Krea'],
  [/\bcraiyon\b/i, 'Craiyon'],
  [/\bmeta ai\b|\bimagine with meta\b/i, 'Meta AI'],
  [/\bkling\b|\bhailuo\b|\bminimax\b/i, 'Kling/Hailuo'],
  [/\bseedream\b|\bseedance\b|\bdreamina\b/i, 'Seedream/Seedance/Dreamina'],
  [/\bgoogle veo\b|\bveo[\s-]?[23]\b/i, 'Google Veo'],
  [/\bpika\s?labs\b|\bpika\.art\b/i, 'Pika'],
  [/\bluma\s?(ai|labs)\b|\bdream machine\b/i, 'Luma Dream Machine'],
  [/\bsynthesia\b|\bheygen\b|\bhunyuan\b|\bvidu\b/i, 'Gerador de vídeo por IA'],
]

const AI_TEXT_KEYS = new Set([
  'parameters', 'prompt', 'workflow', 'negative_prompt', 'Dream', 'sd-metadata', 'invokeai_metadata',
  'invokeai_graph', 'generation_data', 'SD:prompt',
])

const PRIVACY_KEYS = [
  [/Fabricante da câmera|Modelo da câmera|Versão do Android|tiff:Make|tiff:Model/, 'Identifica o aparelho (marca/modelo)'],
  [/Nº de série|SerialNumber|ID único da imagem|ImageUniqueID/, 'Número de série ou ID único do aparelho'],
  [/^Autor|Dono da câmera|Copyright|dc:creator|dc:rights|Contato|Crédito/, 'Nome do autor, dono ou direitos autorais'],
  [/^Data|DateTime|CreateDate|ModifyDate/i, 'Data e hora em que a foto foi tirada/editada'],
  [/Software|CreatorTool|HistorySoftwareAgent/, 'Software usado para criar/editar'],
  [/Cidade|Estado|País|Bairro|City|Country|Location/, 'Localização escrita (cidade/país)'],
  [/^Trilha de metadados/, 'Trilha de dados de sensores/GPS gravada junto com o vídeo'],
]

function analyze(report) {
  const relevant = report.entries.filter((e) => !e.technical)
  const corpus = [...relevant.map((e) => `${e.key}: ${e.value}`), ...report.scanText].join('\n')

  for (const [re, text] of AI_SOURCE_RULES) if (re.test(corpus)) report.signal('ai', text)

  const generators = AI_GENERATORS.filter(([re]) => re.test(corpus)).map(([, name]) => name)
  if (generators.length) report.signal('ai', `Menção a ferramenta de IA: ${generators.join(', ')}`)

  for (const e of relevant) {
    if (e.group === 'PNG texto' && AI_TEXT_KEYS.has(e.key)) {
      report.signal('ai', `Campo "${e.key}" típico de geradores de imagem (Stable Diffusion, ComfyUI etc.)`)
    }
  }

  if (report.c2pa) {
    report.signal(
      'provenance',
      'Content Credentials (C2PA): assinatura de procedência usada por OpenAI, Google, Adobe, Microsoft e algumas câmeras',
    )
  }

  for (const [re, text] of PRIVACY_KEYS) {
    if (relevant.some((e) => re.test(e.key))) report.signal('privacy', text)
  }
  if (relevant.some((e) => e.group === 'Comentário' || e.group === 'PNG texto')) {
    report.signal('privacy', 'Textos/comentários embutidos no arquivo')
  }
}

// ---------- API ----------

export async function inspectMetadata(file) {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer())
  const video = detectVideoFormat(head)
  // Vídeos são lidos em partes; imagens inteiras na memória
  const bytes = video ? null : new Uint8Array(await file.arrayBuffer())
  const format = video ?? detectFormat(bytes)

  const report = {
    entries: [],
    signals: [],
    scanText: [],
    c2pa: false,
    add(group, key, value, technical = false) {
      this.entries.push({ group, key, value: String(value), technical })
    },
    signal(level, text, link) {
      if (!this.signals.some((s) => s.text === text)) this.signals.push({ level, text, link })
    },
  }

  if (!format) {
    return {
      format: null,
      verdict: 'unknown',
      entries: [],
      signals: [{ level: 'info', text: 'Formato não suportado para análise (use JPEG, PNG, WebP, GIF, MP4, MOV, WebM ou MKV)' }],
    }
  }

  if (video) await inspectVideo(file, video, report)
  else if (format === 'jpeg') inspectJpeg(bytes, report)
  else if (format === 'png') await inspectPng(bytes, report)
  else if (format === 'webp') inspectWebp(bytes, report)
  else inspectGif(bytes, report)

  analyze(report)

  const levels = new Set(report.signals.map((s) => s.level))
  const verdict = levels.has('ai')
    ? 'ai'
    : levels.has('provenance') || report.entries.some((e) => !e.technical)
      ? 'dirty'
      : 'clean'

  const order = ['ai', 'provenance', 'privacy', 'info']
  const signals = report.signals.toSorted((a, b) => order.indexOf(a.level) - order.indexOf(b.level))

  return { format, verdict, entries: report.entries, signals }
}
