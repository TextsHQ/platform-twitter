export function* chunkBuffer(buffer: Buffer, maxChunkSize: number): Generator<[number, Buffer]> {
  for (let chunkIndex = 0; chunkIndex < Math.ceil(buffer.length / maxChunkSize); chunkIndex++) {
    const start = chunkIndex * maxChunkSize
    yield [chunkIndex, buffer.slice(start, start + maxChunkSize)]
  }
}

export const promiseDelay = (ms: number) =>
  new Promise<void>(resolve => setTimeout(() => resolve(), ms))
