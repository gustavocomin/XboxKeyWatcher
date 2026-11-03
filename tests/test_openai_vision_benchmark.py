"""Verify the API benchmark sends exactly one fictional image per execution."""
import io
import json
import os
from pathlib import Path
import runpy
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

class SingleImageBenchmarkTest(unittest.TestCase):
    def test_sends_exactly_one_image_and_one_request(self):
        requests = []
        class Response:
            def __enter__(self): return io.BytesIO(json.dumps({'output': [{'content': [{'type':'output_text', 'text':'{"code":null}'}]}]}).encode())
            def __exit__(self, *args): pass
        def fake_open(request, timeout):
            requests.append(json.loads(request.data))
            return Response()
        with patch.dict(os.environ, {'OPENAI_API_KEY':'test-only'}), patch.object(sys, 'argv', ['openai_vision_benchmark.py']), patch('urllib.request.urlopen', fake_open), patch.object(Path, 'write_text'), patch('sys.stdout', new_callable=io.StringIO):
            runpy.run_path(str(ROOT/'benchmarks/openai_vision_benchmark.py'), run_name='__main__')
        self.assertEqual(len(requests), 1)
        contents = requests[0]['input'][0]['content']
        images = [item for item in contents if item['type'] == 'input_image']
        self.assertEqual(len(images), 1)
        self.assertTrue(images[0]['image_url'].startswith('data:image/'))

if __name__ == '__main__': unittest.main()
