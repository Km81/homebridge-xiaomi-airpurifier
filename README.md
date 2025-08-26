# homebridge-xiaomi-airpurifier

[![npm version](https://badge.fury.io/js/homebridge-xiaomi-airpurifier.svg)](https://badge.fury.io/js/homebridge-xiaomi-airpurifier)

최신 Homebridge 및 Node.js 환경에 최적화된 Xiaomi Mi Air Purifier 2S 및 Pro를 위한 현대적인 단일 파일 Homebridge 플러그인입니다.

이 플러그인은 [YinHangCode/homebridge-mi-airpurifier](https://github.com/YinHangCode/homebridge-mi-airpurifier)의 원본 작업을 기반으로 완전히 재작성되었습니다.

## 지원 기기
* Xiaomi Mi Air Purifier 2S (zhimi.airpurifier.mc1)
* Xiaomi Mi Air Purifier Pro (zhimi.airpurifier.v7)

---

## 설치 방법

1.  공식 설명서에 따라 Homebridge를 설치하세요.
2.  다음 명령어를 사용하여 이 플러그인을 설치하세요:
    ```bash
    npm install -g homebridge-xiaomi-airpurifier
    ```
    
---

## 설정 방법

`config.json` 파일에 아래 플랫폼 설정을 추가하세요:

```json
"platforms": [
    {
        "platform": "XiaomiAirPurifierPlatform",
        "deviceCfgs": [
            {
                "type": "MiAirPurifier2S",
                "ip": "192.168.1.XX",
                "token": "YOUR_32_CHARACTER_TOKEN",
                "name": "거실 공기청정기",
                "showTemperature": true,
                "showHumidity": true,
                "showAirQuality": true,
                "showLED": false,
                "showBuzzer": false
            },
            {
                "type": "MiAirPurifierPro",
                "ip": "192.168.1.XY",
                "token": "YOUR_32_CHARACTER_TOKEN",
                "name": "안방 공기청정기",
                "showTemperature": true,
                "showHumidity": true,
                "showAirQuality": true
            }
        ]
    }
]

설정 항목 설명
platform: 반드시 "XiaomiAirPurifierPlatform" 이어야 합니다.

deviceCfgs: 사용 중인 공기청정기 기기 목록을 배열 형태로 입력합니다.

type: 기기 모델명입니다. "MiAirPurifier2S" 또는 "MiAirPurifierPro" 중 하나를 입력합니다.

ip: 공기청정기의 고정 IP 주소입니다.

token: 32자리 Mi Home 기기 토큰입니다.

name: HomeKit에 표시될 액세서리 이름입니다.

showTemperature (선택 사항, 기본값: true): 온도 센서를 숨기려면 false로 설정하세요.

showHumidity (선택 사항, 기본값: true): 습도 센서를 숨기려면 false로 설정하세요.

showAirQuality (선택 사항, 기본값: true): 공기질 센서를 숨기려면 false로 설정하세요.

showLED (선택 사항, 기본값: false): 기기 LED 화면을 제어하는 스위치를 표시하려면 true로 설정하세요.

showBuzzer (선택 사항, 기본값: false): 기기 부저(알림음)를 제어하는 스위치를 표시하려면 true로 설정하세요.
