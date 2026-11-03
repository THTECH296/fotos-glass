# Servidor de teste da interface (modo demonstração no navegador), sem cache.
# Uso: python tools/serve.py <pasta> [porta]   (porta padrão 5310)
import http.server, functools, sys
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
root = sys.argv[1] if len(sys.argv) > 1 else 'src'
port = int(sys.argv[2]) if len(sys.argv) > 2 else 5310
print(f'http://127.0.0.1:{port}  ({root})', flush=True)
http.server.ThreadingHTTPServer(('127.0.0.1', port), functools.partial(H, directory=root)).serve_forever()
