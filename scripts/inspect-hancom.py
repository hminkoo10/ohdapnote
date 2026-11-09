"""설치 글꼴 읽기 전용 조사. python scripts/inspect-hancom.py [글꼴 경로]

fontTools(조사 환경에 설치된 도구)로 cmap과 glyph 이름을 출력한다.
대응표의 E000~E0B4는 설치 글꼴을 Pillow로 렌더해 코드별로 대조했다.
윤곽/글꼴 파일은 출력하거나 복사하지 않는다. 이름 uniE034 자체는 숫자라는 증거가 아니다.
"""
import sys
import json
from pathlib import Path
from fontTools.ttLib import TTFont

if '--build' in sys.argv:
    # 아래 의미값은 두 설치 글꼴의 코드별 렌더를 직접 대조한 값이다.
    # cmap은 코드 존재 확인에만 사용한다. uniXXXX 이름에서 의미를 추측하지 않는다.
    mapping = {}
    for start, chars in [(0xe000, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
                         (0xe01a, 'abcdefghijklmnopqrstuvwxyz'),
                         (0xe0e5, 'abcdefghijklmnopqrstuvwxyz'),
                         (0xe034, '1234567890'),
                         (0xe03e, '!@#$%*()−=+[]{}|,:'),
                         (0xe085, 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ'),
                         (0xe09d, 'αβγδεζηθικλμνξοπρστυφχψω')]:
        mapping.update({chr(start + i): c for i, c in enumerate(chars)})
    mapping.update({chr(k): v for k, v in {
        0xe050: '′', 0xe051: '″', 0xe052: ',', 0xe053: '.', 0xe054: '/',
        0xe055: '<', 0xe056: '>', 0xe057: '?', 0xe058: '←', 0xe05a: '→',
        0xe05b: '∫', 0xe05c: '√', 0xe067: '∑', 0xe068: 'Π', 0xe069: '∏',
        0xe06a: '∩', 0xe06b: '∪', 0xe06f: '⇐', 0xe070: '=', 0xe071: '⇒', 0xe072: '∫'
    }.items()})
    for filename in ['HancomEQN.ttf', 'HYHWPEQ.TTF']:
        cmap = TTFont('C:/Windows/Fonts/' + filename).getBestCmap()
        assert all(ord(c) in cmap for c in mapping), filename
    output = Path(__file__).resolve().parents[1] / 'src/renderer/js/hancom-map.js'
    output.write_text('// 설치 글꼴 cmap 및 렌더 대조. scripts/inspect-hancom.py --build\n'
                      + 'export const HANCOM_PUA = Object.freeze('
                      + json.dumps(mapping, ensure_ascii=True, indent=2) + ');\n',
                      encoding='utf-8', newline='\n')
    print(f'{len(mapping)} mappings')
    sys.exit(0)

for path in sys.argv[1:] or ['C:/Windows/Fonts/HancomEQN.ttf', 'C:/Windows/Fonts/HYHWPEQ.TTF']:
    font = TTFont(path)
    print(path)
    for code, name in font.getBestCmap().items():
        if 0xE000 <= code <= 0xF8FF:
            print(f'{code:04X}\t{name}')
