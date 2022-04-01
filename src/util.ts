export function* chunkBuffer(buffer: Buffer, maxChunkSize: number): Generator<[number, Buffer]> {
  for (let chunkIndex = 0; chunkIndex < Math.ceil(buffer.length / maxChunkSize); chunkIndex++) {
    const start = chunkIndex * maxChunkSize
    yield [chunkIndex, buffer.slice(start, start + maxChunkSize)]
  }
}

const symbols = /[\r\n%#()<>?[\\\]^`{|}]/g
export function urlEncodeSVG(_data: string) {
  const data = _data.replace(/>\s{1,}</g, '><').replace(/\s{2,}/g, ' ')
  return data.replace(symbols, encodeURIComponent)
}

export const DATA_URI_PREFIX = 'data:image/svg+xml,'
