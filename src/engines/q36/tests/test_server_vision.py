#!/usr/bin/env python3
"""Serial live vision, cache isolation, and fixed-length API checks."""
import argparse
import base64
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import time
import urllib.error
import urllib.request
import zlib


def png(rgb):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    rows = (b'\0' + bytes(rgb) * 128) * 128
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 128, 128, 8, 2, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def cached(response):
    usage = response.get('usage', {})
    return (usage.get('cache_read_input_tokens', 0) +
            usage.get('prompt_tokens_details', {}).get('cached_tokens', 0) +
            usage.get('input_tokens_details', {}).get('cached_tokens', 0))


def visible(response):
    if 'choices' in response:
        return response['choices'][0].get('message', {}).get('content', '') or ''
    blocks = response.get('content', [])
    if 'output' in response:
        blocks = [b for item in response['output'] for b in item.get('content', [])]
    return ''.join(b.get('text', '') for b in blocks if b.get('type') in ('text', 'output_text'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, default=Path('./q36-server'))
    parser.add_argument('--model', default='gguf/Qwen3.6-35B-A3B-AntirezExperts-IQ2XXS-gateup-Q2K-down-Q8rest.gguf')
    parser.add_argument('--vision', default='gguf/Qwen3.6-35B-A3B-mmproj-F16.gguf')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--slots', type=int, default=1)
    parser.add_argument('--ctx', type=int, default=16384)
    parser.add_argument('--resident', action='store_true')
    parser.add_argument('--pi', type=Path)
    parser.add_argument('--pi-api', action='append', choices=[
        'openai-completions', 'openai-responses', 'anthropic-messages'])
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    cmd = [str(args.binary.resolve()), '--vulkan', '-m', str(Path(args.model).resolve()),
           '--vision', str(Path(args.vision).resolve()), '--ctx', str(args.ctx),
           '--host', '127.0.0.1', '--port', str(port), '--batched-session', str(args.slots),
           '--trace', str(out / 'trace.txt')]
    if not args.resident:
        cmd.append('--ssd-streaming')
    (out / 'command.json').write_text(json.dumps(cmd))
    sequence = 0

    def request(api, body, status=200):
        nonlocal sequence
        sequence += 1
        (out / f'{sequence:02d}-request.json').write_text(json.dumps(body))
        req = urllib.request.Request(base + api, data=json.dumps(body).encode(),
                                     headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=240) as response:
                code, data = response.status, response.read()
        except urllib.error.HTTPError as error:
            code, data = error.code, error.read()
        (out / f'{sequence:02d}-response.json').write_bytes(data)
        assert code == status, (api, code, data[:1000])
        return json.loads(data)

    images = {}
    for name, color in [('red', (255, 0, 0)), ('blue', (0, 0, 255))]:
        data = png(color)
        (out / f'{name}.png').write_bytes(data)
        images[name] = base64.b64encode(data).decode()

    def image_part(color, api):
        if api == 'anthropic':
            return {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png', 'data': images[color]}}
        return {'type': 'input_image' if api == 'responses' else 'image_url',
                'image_url': 'data:image/png;base64,' + images[color]}

    with (out / 'server.log').open('w') as log:
        process = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 180
            while True:
                assert process.poll() is None, 'server exited; see server.log'
                try:
                    with urllib.request.urlopen(base + '/v1/models', timeout=1):
                        break
                except (OSError, urllib.error.URLError):
                    assert time.monotonic() < deadline, 'server startup timed out'
                    time.sleep(0.2)
            question = 'Name the dominant color of the most recent image. Answer with one lowercase word.'
            for api, endpoint, key, limit in [('chat', '/v1/chat/completions', 'messages', 'max_tokens'),
                                               ('responses', '/v1/responses', 'input', 'max_output_tokens'),
                                               ('anthropic', '/v1/messages', 'messages', 'max_tokens')]:
                text_type = 'input_text' if api == 'responses' else 'text'
                messages = [{'role': 'user', 'content': [image_part('red', api), {'type': text_type, 'text': question}]}]
                body = {key: messages, limit: 16, 'temperature': 0, 'think': False,
                        'model': 'qwen3.6-35b-a3b-nothink'}
                first = request(endpoint, body)
                assert 'red' in visible(first).lower(), (api, visible(first))
                messages += [{'role': 'assistant', 'content': visible(first)},
                             {'role': 'user', 'content': 'Repeat that color. One word.'}]
                continued = request(endpoint, body)
                assert 'red' in visible(continued).lower(), (api, visible(continued))
                assert cached(continued) > 0, (api, 'lost matching vision prefix', continued.get('usage'))
                # Force a fresh text frontier, then replay the same conditioned conversation.
                request('/v1/chat/completions', {'messages': [{'role': 'user', 'content': 'Say OK.'}],
                                                'max_tokens': 1, 'temperature': 0, 'think': False})
                fresh = request(endpoint, body)
                assert visible(fresh) == visible(continued), (api, 'fresh/reused output mismatch')
                # Identical pad tokens with different pixels must rebuild.
                messages[0]['content'][0] = image_part('blue', api)
                messages[1]['content'] = 'blue'
                changed = request(endpoint, body)
                assert cached(changed) == 0, (api, 'reused an image with a different identity')
                assert 'blue' in visible(changed).lower(), (api, visible(changed))
                messages += [{'role': 'assistant', 'content': visible(changed)},
                             {'role': 'user', 'content': [image_part('red', api), {'type': text_type, 'text': question}]}]
                added = request(endpoint, body)
                assert cached(added) > 0, (api, 'new image lost old conditioned prefix')
                assert 'red' in visible(added).lower(), (api, visible(added))
                fixed = {key: [{'role': 'user', 'content': 'Reply OK.'}], limit: 8,
                         'think': False, 'temperature': 0, 'ignore_eos': True}
                response = request(endpoint, fixed)
                usage = response['usage']
                assert usage.get('completion_tokens', usage.get('output_tokens')) == 8, (api, usage)
                fixed['temperature'] = 0.5
                request(endpoint, fixed, 400)
                print('PASS', api, 'image identity, prefix append, fresh replay, fixed length', flush=True)
            # Tool results carrying images exercise coding-client request shapes.
            for api, endpoint, key, limit in [('responses', '/v1/responses', 'input', 'max_output_tokens'),
                                               ('anthropic', '/v1/messages', 'messages', 'max_tokens')]:
                text = {'type': 'input_text' if api == 'responses' else 'text', 'text': question}
                if api == 'responses':
                    messages = [{'type': 'function_call', 'name': 'read', 'call_id': 'image-test', 'arguments': '{}'},
                                {'type': 'function_call_output', 'call_id': 'image-test', 'output': [image_part('blue', api), text]}]
                else:
                    messages = [{'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'image-test', 'name': 'read', 'input': {}}]},
                                {'content': [{'type': 'tool_result', 'tool_use_id': 'image-test', 'content': [image_part('blue', api), text]}], 'role': 'user'}]
                response = request(endpoint, {key: messages, limit: 16, 'temperature': 0, 'think': False})
                assert 'blue' in visible(response).lower(), (api, visible(response))
                print('PASS', api, 'image tool result', flush=True)
            # A complete pending call-ID set authenticates a tool-only continuation.
            for api, endpoint, key, limit in [('chat', '/v1/chat/completions', 'messages', 'max_tokens'),
                                               ('responses', '/v1/responses', 'input', 'max_output_tokens'),
                                               ('anthropic', '/v1/messages', 'messages', 'max_tokens')]:
                schema = {'name': 'checkpoint', 'description': 'Complete the required checkpoint.',
                          'parameters': {'type': 'object', 'properties': {}}}
                if api == 'chat':
                    tool = {'type': 'function', 'function': schema}
                elif api == 'responses':
                    tool = {'type': 'function', **schema}
                else:
                    tool = {'name': schema['name'], 'description': schema['description'],
                            'input_schema': schema['parameters']}
                text_type = 'input_text' if api == 'responses' else 'text'
                for add_image in (False, True):
                    prompt = 'Call checkpoint with empty arguments once. After it finishes, name the dominant color of the most recent image in one word.'
                    body = {key: [{'role': 'user', 'content': [image_part('red', api),
                                                               {'type': text_type, 'text': prompt}]}],
                            'tools': [tool], limit: 128, 'temperature': 0, 'think': False}
                    first = request(endpoint, body)
                    if api == 'chat':
                        calls = first['choices'][0]['message'].get('tool_calls', [])
                        call_ids = [c['id'] for c in calls]
                    elif api == 'responses':
                        calls = [c for c in first.get('output', []) if c['type'] == 'function_call']
                        call_ids = [c['call_id'] for c in calls]
                    else:
                        calls = [c for c in first.get('content', []) if c['type'] == 'tool_use']
                        call_ids = [c['id'] for c in calls]
                    assert len(call_ids) == 1, (api, 'checkpoint tool not called', first)
                    parts = ([image_part('blue', api)] if add_image else []) + [
                        {'type': text_type, 'text': 'Checkpoint completed. Answer the original color question with one word; do not call tools again.'}]
                    def tool_result(call_id):
                        if api == 'chat':
                            return {'role': 'tool', 'tool_call_id': call_id, 'content': parts}
                        if api == 'responses':
                            return {'type': 'function_call_output', 'call_id': call_id, 'output': parts}
                        return {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': call_id, 'content': parts}]}
                    body[key] = [tool_result(call_ids[0])]
                    continued = request(endpoint, body)
                    assert cached(continued) > 0, (api, 'tool-only request lost its authenticated image context')
                    expected = 'blue' if add_image else 'red'
                    assert expected in visible(continued).lower(), (api, expected, continued)
                    body[key] = [tool_result('unrecognized-call-id')]
                    cold = request(endpoint, body)
                    assert cached(cold) == 0, (api, 'unknown call ID reused a private image context')
                print('PASS', api, 'authenticated tool-only history, new image, unknown-ID isolation', flush=True)
            bad = {'messages': [{'role': 'user', 'content': [{'type': 'image_url', 'image_url': 'data:image/png;base64,YmFk'}]}]}
            response = request('/v1/chat/completions', bad, 400)
            assert 'image' in json.dumps(response).lower(), response
            print('PASS invalid image rejected', flush=True)
            if args.pi:
                subprocess.run(['python3', str(Path(__file__).with_name('test_server_vision_agent.py').resolve()),
                                '--url', base, '--pi', str(args.pi.resolve()),
                                '--output', str(out / 'pi')] +
                               [arg for api in args.pi_api or [] for arg in ('--api', api)],
                               check=True, timeout=1900)
        finally:
            process.terminate()
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
    assert 'vision embedding cache hit' in (out / 'server.log').read_text()


if __name__ == '__main__':
    main()
