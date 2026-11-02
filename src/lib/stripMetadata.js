// Remove metadados de imagens direto nos bytes do arquivo (sem recomprimir),
// para JPEG, PNG, WebP e GIF. Outros formatos são redesenhados em canvas e
// exportados como PNG.

import { ascii, concat, detectFormat, gifBlocks, jpegSegments, pngChunks, webpChunks } from './imageFormat'

// ---------- JPEG ----------

function readExifOrientation(bytes, start, end) {
  // start aponta para "Exif\0\0"
  const tiff = start + 6
  if (tiff + 8 > end) return 1
  const little = bytes[tiff] === 0x49
  const u16 = (o) => (little ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1])
  const u32 = (o) =>
    little
      ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0
      : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0
  const ifd = tiff + u32(tiff + 4)
  if (ifd + 2 > end) return 1
  const count = u16(ifd)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > end) break
    if (u16(entry) === 0x0112) return u16(entry + 8) || 1
  }
  return 1
}

// APP1 mínimo contendo apenas a tag de orientação, para a foto não "girar"
function buildOrientationExif(orientation) {
  const payload = [
    ...[0x45, 0x78, 0x69, 0x66, 0x00, 0x00], // "Exif\0\0"
    ...[0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08], // TIFF big-endian, IFD0 em 8
    ...[0x00, 0x01], // 1 entrada
    ...[0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01], // Orientation, SHORT, count 1
    ...[0x00, orientation, 0x00, 0x00],
    ...[0x00, 0x00, 0x00, 0x00], // sem próximo IFD
  ]
  const len = payload.length + 2
  return new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff, ...payload])
}

function stripJpeg(bytes) {
  const keep = [bytes.subarray(0, 2)]
  const removed = new Set()
  let orientation = 1

  for (const { marker, start, end, data } of jpegSegments(bytes)) {
    let drop = false

    if (marker === 0xe1) {
      const id = ascii(bytes, data, 6)
      if (id.startsWith('Exif')) {
        orientation = readExifOrientation(bytes, data, end)
        removed.add('EXIF')
      } else {
        removed.add('XMP')
      }
      drop = true
    } else if (marker === 0xe0) {
      // Mantém só o JFIF básico; JFXX traz miniatura
      drop = ascii(bytes, data, 5) !== 'JFIF\0'
      if (drop) removed.add('Miniatura JFXX')
    } else if (marker === 0xe2) {
      // Perfil de cor ICC é mantido para não alterar as cores
      drop = ascii(bytes, data, 11) !== 'ICC_PROFILE'
      if (drop) removed.add('APP2 (FlashPix/MPF)')
    } else if (marker === 0xee) {
      // Segmento Adobe é necessário para decodificar CMYK corretamente
      drop = ascii(bytes, data, 5) !== 'Adobe'
    } else if (marker === 0xed) {
      removed.add('IPTC/Photoshop')
      drop = true
    } else if (marker === 0xeb) {
      removed.add('C2PA/JUMBF')
      drop = true
    } else if (marker >= 0xe3 && marker <= 0xef) {
      removed.add(`APP${marker - 0xe0}`)
      drop = true
    } else if (marker === 0xfe) {
      removed.add('Comentário')
      drop = true
    }

    if (!drop) keep.push(bytes.subarray(start, end))
  }

  if (orientation > 1 && orientation <= 8) {
    keep.splice(1, 0, buildOrientationExif(orientation))
  }
  return { bytes: concat(keep), removed: [...removed] }
}

// ---------- PNG ----------

// Só os chunks necessários para exibir a imagem corretamente são mantidos;
// qualquer outro (texto, EXIF, C2PA, dados de aplicativos) sai.
const PNG_KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT',
  'pHYs', 'bKGD', 'cICP', 'mDCV', 'cLLI', 'acTL', 'fcTL', 'fdAT',
])

const PNG_LABELS = {
  tEXt: 'Texto',
  zTXt: 'Texto',
  iTXt: 'Texto/XMP',
  eXIf: 'EXIF',
  tIME: 'Data de modificação',
  caBX: 'C2PA',
}

function stripPng(bytes) {
  const keep = [bytes.subarray(0, 8)]
  const removed = new Set()
  for (const { type, start, end } of pngChunks(bytes)) {
    if (PNG_KEEP.has(type)) keep.push(bytes.subarray(start, end))
    else removed.add(PNG_LABELS[type] ?? `Chunk ${type}`)
  }
  return { bytes: concat(keep), removed: [...removed] }
}

// ---------- WebP ----------

const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP'])
const WEBP_LABELS = { EXIF: 'EXIF', 'XMP ': 'XMP', C2PA: 'C2PA' }

function stripWebp(bytes) {
  const keep = []
  const removed = new Set()
  for (const { type, start, end } of webpChunks(bytes)) {
    if (!WEBP_KEEP.has(type)) {
      removed.add(WEBP_LABELS[type] ?? `Chunk ${type.trim()}`)
      continue
    }
    const chunk = bytes.slice(start, end)
    // Desliga as flags de EXIF (bit 3) e XMP (bit 2) no cabeçalho estendido
    if (type === 'VP8X') chunk[8] &= ~0x0c
    keep.push(chunk)
  }
  const body = concat(keep)
  const header = new Uint8Array(12)
  header.set(bytes.subarray(0, 4), 0)
  new DataView(header.buffer).setUint32(4, body.length + 4, true)
  header.set(bytes.subarray(8, 12), 8)
  return { bytes: concat([header, body]), removed: [...removed] }
}

// ---------- GIF ----------

function stripGif(bytes) {
  const keep = []
  const removed = new Set()
  for (const block of gifBlocks(bytes)) {
    const { kind, label, start, end } = block
    if (kind === 'ext' && label === 0xfe) {
      removed.add('Comentário')
      continue
    }
    // Mantém só o bloco NETSCAPE (loop da animação); XMP e outros saem
    if (kind === 'ext' && label === 0xff && ascii(bytes, start + 3, 8) !== 'NETSCAPE') {
      removed.add(ascii(bytes, start + 3, 3) === 'XMP' ? 'XMP' : 'Dados de aplicativo')
      continue
    }
    keep.push(bytes.subarray(start, end))
  }
  return { bytes: concat(keep), removed: [...removed] }
}

// ---------- Fallback via canvas ----------

async function redrawAsPng(file) {
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d').drawImage(bitmap, 0, 0)
  bitmap.close()
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('Não foi possível converter a imagem')
  return blob
}

const STRIPPERS = { jpeg: stripJpeg, png: stripPng, webp: stripWebp, gif: stripGif }
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }

export async function stripMetadata(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const format = detectFormat(bytes)

  if (format) {
    const result = STRIPPERS[format](bytes)
    return {
      blob: new Blob([result.bytes], { type: MIME[format] }),
      name: file.name,
      removed: result.removed,
      method: 'lossless',
    }
  }

  try {
    const blob = await redrawAsPng(file)
    return {
      blob,
      name: file.name.replace(/\.[^.]+$/, '') + '.png',
      removed: ['Todos (convertida para PNG)'],
      method: 'converted',
    }
  } catch {
    throw new Error('Formato não suportado pelo navegador')
  }
}
