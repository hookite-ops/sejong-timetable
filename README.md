# 세종 시간표

세종특별자치시(교육청 코드 I10) 초·중·고·특수·각종학교 109곳의 시간표(NEIS)를 보고,
교시마다 메모를 남기면 같은 반 시간표를 보는 사람 모두에게 공유되는 모바일 웹앱입니다.
('새움중 시간표'를 세종시 전체로 넓힌 버전 — 예전에 저장한 새움중 반·시간은 그대로 이어집니다.)

## 실행
- 로컬: `node server.js` → http://localhost:8080 (Node 20 이상, 설치할 패키지 없음)
- 메모는 로컬에서는 메모리 + `data/memos.json`에 저장됩니다.

## Cloud Run 배포
이 폴더를 그대로 올리면 됩니다(Dockerfile 포함, PORT 자동).
```
gcloud run deploy sejong-timetable --source . --region asia-northeast3 --allow-unauthenticated --max-instances 2
```
속도 제한·NEIS 캐시는 인스턴스 메모리에 있어서 인스턴스마다 따로 셉니다. **최대 인스턴스를 1~2로 낮게** 두세요
(콘솔: Cloud Run → 서비스 → 수정 → 자동 확장 → 최대 인스턴스).
GitHub 저장소에 올리고 Cloud Run "지속적 배포(Dockerfile)"로 연결해도 됩니다.

### 메모 공유를 Firestore로 켜기 (Cloud Run에서 필수)
Cloud Run은 인스턴스가 여러 개거나 재시작되면 파일이 사라지므로 Firestore를 씁니다.
1. 콘솔 → Firestore → 데이터베이스 만들기 → **네이티브 모드**, ID는 **`(default)`**, 위치는 `asia-northeast3`(서울) 권장
2. IAM → Cloud Run 서비스가 쓰는 서비스 계정(기본: `PROJECT_NUMBER-compute@developer.gserviceaccount.com`)에 **Cloud Datastore User** 역할 추가
3. 재배포. 서버가 메타데이터 서버에서 프로젝트 ID·토큰을 자동으로 받아 Firestore REST로 저장합니다.
   복합 인덱스는 필요 없습니다(`key` 필드 하나로만 조회). 확인: `/api/status` → `"store":"firestore"`

## 환경 변수 (모두 선택)
| 이름 | 설명 |
|---|---|
| `NEIS_KEY` | **필수.** NEIS 인증키. Cloud Run 서비스의 환경 변수로 넣음. 코드·저장소에는 키가 없음 |
| `RATE_PER_IP` / `RATE_PER_IP_HOUR` | IP당 메모 수 1분 30개 / 1시간 200개 (학교 와이파이 공유 고려) |
| `RATE_GET_PER_IP` | IP당 1분 60번: 캐시에 없어 NEIS를 실제로 부르는 조회만 셈 |
| `RATE_STORE_PER_IP` | IP당 1분 300번: 캐시(25초)에 없어 메모 저장소를 실제로 읽는 조회만 셈 |
| `RATE_PER_DEVICE` | 기기당 1분 메모 수 (기본 5) |
| `MEMO_SALT` | 작성자 토큰 해시 소금값 (배포 때 바꾸길 권장) |
| `MEMO_STORE=local` | Cloud Run에서도 Firestore 대신 파일 저장 강제 |
| `MEMO_COLLECTION` | Firestore 컬렉션 이름 (기본 `memos`) |

## 안전장치
- 메모 200자·닉네임 12자. 기기당 1분 5개, IP당 1분 30개·1시간 200개, 한 반·주에 1분 20개, 한 교시 최대 20개
- 그날 시간표에 있는 교시에만 메모 가능(시간표가 빈 날은 허용). 조회 주는 오늘 앞뒤 1년만
- 욕설 마스킹(띄어쓰기·숫자 끼운 우회 포함), 전화번호·링크 가림
- 작성자만 삭제(브라우저 랜덤 토큰, 서버엔 해시만 저장). 신고는 기기당 1번, 같은 IP에선 한 메모에 최대 2표까지 인정(넘는 신고는 기록도 안 함), 3표면 숨김
- 화면은 모두 HTML 이스케이프 + CSP, 요청 학교·학년·반은 실제 NEIS 반 목록으로 검증
- NEIS는 서버의 /api/* 로만 부르고 세종(I10) 학교 코드만 허용. NEIS 응답은 캐시(학교 1일, 반 6시간, 시간표 20분)

## 아이폰·안드로이드
Safari/Chrome에서 주소 열기 → 공유(메뉴) → "홈 화면에 추가"
