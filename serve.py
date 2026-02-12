"""Serve the current directory on localhost:8000."""
import http.server
import webbrowser

PORT = 8000
webbrowser.open(f"http://localhost:{PORT}")
http.server.test(HandlerClass=http.server.SimpleHTTPRequestHandler, port=PORT)
