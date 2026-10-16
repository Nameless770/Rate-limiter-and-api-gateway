import type http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Bind a server and resolve with where it ended up (useful when the port is 0). */
export function listenOn(server: http.Server, port: number, host: string): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address() as AddressInfo);
    });
  });
}
