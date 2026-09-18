# Petit serveur statique de développement : comme `python3 -m http.server`,
# mais interdit toute mise en cache du navigateur, sinon on teste de vieux
# fichiers sans s'en rendre compte.
import http.server
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8770


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, *args):
        pass


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", PORT), NoCacheHandler) as httpd:
    print(f"serving on http://localhost:{PORT}")
    httpd.serve_forever()
