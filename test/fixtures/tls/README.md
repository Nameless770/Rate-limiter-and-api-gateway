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
