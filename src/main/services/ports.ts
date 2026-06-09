import net from 'node:net'

function tryListen(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.unref()
    srv.once('error', () => resolve(null))
    srv.listen(port, '127.0.0.1', () => {
      const addr = srv.address()
      const got = typeof addr === 'object' && addr !== null ? addr.port : null
      srv.close(() => resolve(got))
    })
  })
}

/** Bind the preferred port if free, otherwise let the OS pick one. */
export async function allocatePort(preferred: number): Promise<number> {
  const port = (await tryListen(preferred)) ?? (await tryListen(0))
  if (port === null) throw new Error(`Could not allocate a port (preferred ${preferred})`)
  return port
}
