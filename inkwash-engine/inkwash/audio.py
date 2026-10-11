"""混音：旁白完整保留；古筝 BGM 经侧链压缩在说话时自动闪避；两遍 loudnorm 到 -16 LUFS。"""
from __future__ import annotations

import json
import os
import re
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'assets')
TOTAL = 130.1

GRAPH = (
    "[0:a]aresample=48000,pan=stereo|c0=c0|c1=c0,apad,atrim=0:{T},asplit=2[nar][key];"
    "[1:a]aresample=48000,atrim=0:{T},volume=-8dB,afade=t=out:st={fo}:d=2.6[bg];"
    "[bg][key]sidechaincompress=threshold=0.015:ratio=4:attack=60:release=700:knee=4[duck];"
    "[nar][duck]amix=inputs=2:normalize=0:duration=first[m]"
)


def _run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True)


def mix(out_wav):
    nar = os.path.join(ASSETS, 'narration.mp3')
    bgm = os.path.join(ASSETS, 'bgm.mp3')
    g = GRAPH.format(T=TOTAL, fo=TOTAL - 2.8)
    r = _run(['ffmpeg', '-hide_banner', '-i', nar, '-i', bgm, '-filter_complex',
              g + ';[m]loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json[o]', '-map', '[o]', '-f', 'null', '-'])
    js = json.loads(re.findall(r'\{[^{}]*"input_i"[^{}]*\}', r.stderr)[-1])
    ln = ('loudnorm=I=-16:TP=-1.5:LRA=11:linear=true:'
          f"measured_I={js['input_i']}:measured_TP={js['input_tp']}:measured_LRA={js['input_lra']}:"
          f"measured_thresh={js['input_thresh']}:offset={js['target_offset']}")
    _run(['ffmpeg', '-y', '-hide_banner', '-i', nar, '-i', bgm, '-filter_complex',
          g + f';[m]{ln},aresample=48000[o]', '-map', '[o]', '-c:a', 'pcm_s16le', out_wav])
    return out_wav


def measure(path):
    r = subprocess.run(['ffmpeg', '-hide_banner', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'],
                       capture_output=True, text=True)
    tail = r.stderr[r.stderr.rfind('Summary:'):]
    return tail


if __name__ == '__main__':
    os.makedirs(os.path.join(ROOT, 'out'), exist_ok=True)
    w = mix(os.path.join(ROOT, 'out', 'mix.wav'))
    print(measure(w))
