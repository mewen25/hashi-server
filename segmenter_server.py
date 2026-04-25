# segmenter_server.py
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

from sudachipy import dictionary, tokenizer

tokenizer_obj = dictionary.Dictionary().create()
mode = tokenizer.Tokenizer.SplitMode.C

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers["Content-Length"])
        kana = self.rfile.read(length).decode()

        morphemes = tokenizer_obj.tokenize(kana, mode)
        result = [
            {
                "reading": m.reading_form(),
                "surface": m.surface(),
                "dictionary_form": m.dictionary_form(),
                "pos": m.part_of_speech()[0],
            }
            for m in morphemes
        ]

        print("tokened: "+str(result))

        body = json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args): pass  # silence request logs

print("listening for segmenter requests on 7331")
HTTPServer(("127.0.0.1", 7331), Handler).serve_forever()
