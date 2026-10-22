# Test-only TLS material

`localhost-cert.pem` / `localhost-key.pem` are a self-signed certificate and key for `localhost` and
`127.0.0.1`, used by the HTTPS-upstream tests. The key is public by design: never trust this certificate
anywhere outside the test suite.

Regenerate with:

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout localhost-key.pem -out localhost-cert.pem -days 36500 \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

Also here:

- `localhost2-cert.pem` / `localhost2-key.pem`: a *different* certificate and key for the same names, so tests can
  prove that a certificate reload really swaps what clients see.
- `localhost-key-encrypted.pem`: the first key re-encrypted with the passphrase `test-passphrase-not-a-secret`
  (it protects nothing: it exists to test passphrase-protected keys).
- `client-cert.pem` / `client-key.pem`: a self-signed *client* certificate (`CN=gateway-client`, extended key usage
  `clientAuth`), which the gateway presents to upstreams that require mutual TLS. Regenerate with (in Git Bash on
  Windows, prefix `MSYS_NO_PATHCONV=1` so `-subj` is not mistaken for a path):

  ```bash
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout client-key.pem -out client-cert.pem -days 36500 \
    -subj "/CN=gateway-client" -addext "extendedKeyUsage=clientAuth"
  ```

- `callers/`: certificates for *callers* authenticating to the gateway (route auth method `client-cert`):
  - `ca-cert.pem`: the test CA that issues them (`CN=Test Callers CA`); its key was discarded after signing.
  - `alice-*.pem`, `bob-*.pem`: valid client certificates it issued.
  - `mallory-*.pem`: issued, then revoked; `crl.pem` is the CA's revocation list saying so.
  - `expired-*.pem`: issued with a validity period that ended in 2021.
  - `impostor-*.pem`: a certificate with exactly alice's subject, from a different CA (`other-ca-cert.pem`). It
    must never pass as alice; trusted alongside the first CA, it must be a different caller.

  They were made with `openssl ca` (to be able to revoke one and publish a CRL). To regenerate them, issue the same
  subjects (`/O=Gateway Tests/CN=<name>`, extended key usage `clientAuth`) from a fresh CA, revoke mallory's with
  `openssl ca -revoke` and write the list with `openssl ca -gencrl`.
