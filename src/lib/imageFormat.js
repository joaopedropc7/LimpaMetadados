// Utilitários compartilhados para percorrer a estrutura binária das imagens.

export const ascii = (bytes, start, len) =>
  String.fromCharCode(...bytes.subarray(start, Math.min(start + len, bytes.length)))

export function concat(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

export function detectFormat(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg'
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') return 'png'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp'
  if (ascii(bytes, 0, 3) === 'GIF') return 'gif'
  return null
}

// Segmentos do JPEG até o início dos dados da imagem (SOS).
// O último item tem marker 0xda e vai até o fim do arquivo.
export function* jpegSegments(bytes) {
  let pos = 2
  while (pos < bytes.length) {
    if (bytes[pos] !== 0xff) throw new Error('JPEG corrompido')
    const marker = bytes[pos + 1]
    if (marker === 0xff) {
      pos++
      continue
    }
    if (marker === 0xda) {
      yield { marker, start: pos, end: bytes.length, data: pos + 4 }
      return
    }
    // Marcadores sem tamanho
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      yield { marker, start: pos, end: pos + 2, data: pos + 2 }
      pos += 2
      continue
    }
    const end = pos + 2 + ((bytes[pos + 2] << 8) | bytes[pos + 3])
    yield { marker, start: pos, end, data: pos + 4 }
    pos = end
  }
}

export function* pngChunks(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = 8
  while (pos + 8 <= bytes.length) {
    const len = view.getUint32(pos)
    const type = ascii(bytes, pos + 4, 4)
    const end = pos + 12 + len
    yield { type, start: pos, end, data: pos + 8, len }
    pos = end
    if (type === 'IEND') return
  }
}

export function* webpChunks(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = 12
  while (pos + 8 <= bytes.length) {
    const type = ascii(bytes, pos, 4)
    const len = view.getUint32(pos + 4, true)
    const end = pos + 8 + len + (len & 1)
    yield { type, start: pos, end, data: pos + 8, len }
    pos = end
  }
}

function skipSubBlocks(bytes, pos) {
  while (pos < bytes.length && bytes[pos] !== 0) pos += bytes[pos] + 1
  return pos + 1
}

const colorTableSize = (flags) => (flags & 0x80 ? 3 * (1 << ((flags & 0x07) + 1)) : 0)

// Blocos do GIF: cabeçalho, quadros, extensões e terminador
export function* gifBlocks(bytes) {
  let pos = 13 + colorTableSize(bytes[10])
  yield { kind: 'header', start: 0, end: pos }

  while (pos < bytes.length) {
    const start = pos
    const block = bytes[pos]
    if (block === 0x3b) {
      yield { kind: 'trailer', start, end: pos + 1 }
      return
    }
    if (block === 0x2c) {
      pos += 10 + colorTableSize(bytes[pos + 9])
      pos = skipSubBlocks(bytes, pos + 1) // +1 = tamanho mínimo do código LZW
      yield { kind: 'image', start, end: pos }
      continue
    }
    if (block === 0x21) {
      const label = bytes[pos + 1]
      pos = skipSubBlocks(bytes, pos + 2)
      yield { kind: 'ext', label, start, end: pos }
      continue
    }
    throw new Error('GIF corrompido')
  }
}

// Junta os sub-blocos de dados de uma extensão GIF
export function gifSubBlockData(bytes, pos) {
  const parts = []
  while (pos < bytes.length && bytes[pos] !== 0) {
    parts.push(bytes.subarray(pos + 1, pos + 1 + bytes[pos]))
    pos += bytes[pos] + 1
  }
  return concat(parts)
}
