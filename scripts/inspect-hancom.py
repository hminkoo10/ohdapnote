"""설치 글꼴 읽기 전용 조사. python scripts/inspect-hancom.py [글꼴 경로]

fontTools(조사 환경에 설치된 도구)로 cmap과 glyph 이름을 출력한다.
대응표의 E000~E0B4는 설치 글꼴을 Pillow로 렌더해 코드별로 대조했다.
윤곽/글꼴 파일은 출력하거나 복사하지 않는다. 이름 uniE034 자체는 숫자라는 증거가 아니다.
"""
import sys
from fontTools.ttLib import TTFont

for path in sys.argv[1:] or ['C:/Windows/Fonts/HancomEQN.ttf', 'C:/Windows/Fonts/HYHWPEQ.TTF']:
    font = TTFont(path)
    print(path)
    for code, name in font.getBestCmap().items():
        if 0xE000 <= code <= 0xF8FF:
            print(f'{code:04X}\t{name}')
