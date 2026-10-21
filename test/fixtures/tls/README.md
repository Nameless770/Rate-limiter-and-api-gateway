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
