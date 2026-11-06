# Rascunho — Colagem em cascata em várias abas (`benchmarks/browser-cascade-test.mjs`)

Dados extraídos das 3 execuções do modo de cenários (`node benchmarks\browser-cascade-test.mjs`) e da varredura (`node benchmarks\browser-cascade-test.mjs --sweep --out docs\cascata-sweep.json`), na porta de teste `47993`.

## 1. Execuções dos cenários funcionais (3 rodadas)

### Resumo dos cenários (rodadas 1, 2 e 3)

| Cenário | Rodada 1 | Rodada 2 | Rodada 3 |
|---|---|---|---|
| 1. 5 abas armadas + 1 fixture não armada + 1 `about:blank` | `passed: true` (`armedFilled: 5`, `unarmedEmpty: true`, `blankEmpty: true`, `/pending` → 204 em `1,47 ms`) | `passed: true` (`armedFilled: 5`, `unarmedEmpty: true`, `blankEmpty: true`, `/pending` → 204 em `1,36 ms`) | `passed: true` (`armedFilled: 5`, `unarmedEmpty: true`, `blankEmpty: true`, `/pending` → 204 em `1,45 ms`) |
| 2. Limite de abas (6 armadas, 5 atrasos) | `passed: true` (`filledTabs: 5`, `emptyTabs: 1`) | `passed: true` (`filledTabs: 5`, `emptyTabs: 1`) | `passed: true` (`filledTabs: 5`, `emptyTabs: 1`) |
| 3. Mesma key novamente após `clear` (espera de 2000 ms) | `passed: true` (`newFilledEntries: 0`) | `passed: true` (`newFilledEntries: 0`) | `passed: true` (`newFilledEntries: 0`) |
| 4. Segunda key substitui a primeira nas 5 abas | `passed: true` (`replacedTabs: 5`) | `passed: true` (`replacedTabs: 5`) | `passed: true` (`replacedTabs: 5`) |
| 5. Relatório pós-preenchimento (`page`) no `cascadeLog` | `passed: true` (`entriesWithPage: 5`, `allFieldPresent: true`, `allFieldHasKey: true`) | `passed: true` (`entriesWithPage: 5`, `allFieldPresent: true`, `allFieldHasKey: true`) | `passed: true` (`entriesWithPage: 5`, `allFieldPresent: true`, `allFieldHasKey: true`) |
| 6. Cascata desligada (`enabled: false`) | `passed: true` (`filledTabs: 0`, `newLogEntries: 0`) | `passed: true` (`filledTabs: 0`, `newLogEntries: 0`) | `passed: true` (`filledTabs: 0`, `newLogEntries: 0`) |

### Tempos por slot no Cenário 1 (`delays: [0, 100, 300, 600, 1000]`)

| Slot | `scheduledMs` | Rodada 1 `actualMs` (`diffMs` / `applyMs`) | Rodada 2 `actualMs` (`diffMs` / `applyMs`) | Rodada 3 `actualMs` (`diffMs` / `applyMs`) |
|---:|---:|---:|---:|---:|
| 0 | 0 | 48 ms (+48 ms / 1,4 ms) | 9 ms (+9 ms / 0,7 ms) | 2 ms (+2 ms / 0,6 ms) |
| 1 | 100 | 106 ms (+6 ms / 0,8 ms) | 101 ms (+1 ms / 0,7 ms) | 121 ms (+21 ms / 1,1 ms) |
| 2 | 300 | 300 ms (+0 ms / 0,6 ms) | 301 ms (+1 ms / 0,5 ms) | 301 ms (+1 ms / 0,7 ms) |
| 3 | 600 | 600 ms (+0 ms / 0,7 ms) | 602 ms (+2 ms / 0,8 ms) | 600 ms (+0 ms / 0,6 ms) |
| 4 | 1000 | 1001 ms (+1 ms / 0,8 ms) | 1001 ms (+1 ms / 0,6 ms) | 1000 ms (+0 ms / 0,7 ms) |

---

## 2. Varredura (`--sweep`) — `docs/cascata-sweep.json`

### Memória da árvore do Edge e atraso da última aba por `N` (5 repetições por `N`)

| Abas (`N`) | Processos Edge | Memória Working Set (MB) | Memória Working Set (bytes) | Último slot configurado (ms) | Última aba Mediana (ms) | Última aba p90 (ms) | Última aba Máx (ms) | Diferença Mediana (ms) | Diferença p90 (ms) | Diferença Máx (ms) |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 19 | 930,24 | 975.425.536 | 0 | 1 | 3 | 3 | +1 | +3 | +3 |
| 3 | 21 | 1051,66 | 1.102.745.600 | 300 | 300 | 301 | 301 | 0 | +1 | +1 |
| 5 | 23 | 1164,59 | 1.221.156.864 | 1000 | 1000 | 1010 | 1010 | 0 | +10 | +10 |
| 8 | 26 | 1340,75 | 1.405.874.176 | 2500 | 2500 | 2501 | 2501 | 0 | +1 | +1 |
| 10 | 28 | 1455,39 | 1.526.091.776 | 3500 | 3501 | 3501 | 3501 | +1 | +1 | +1 |

### Detalhamento por slot na varredura (5 repetições)

#### `N = 1` (`delays: [0]`)

| Slot | `scheduledMs` | `actualValuesMs` (5 rodadas) | Mín (ms) | Mediana (ms) | p90 (ms) | Máx (ms) | Dif. Mediana (ms) | Dif. p90 (ms) | Dif. Máx (ms) |
|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 0 | 0 | `[3, 1, 1, 1, 1]` | 1 | 1 | 3 | 3 | +1 | +3 | +3 |

#### `N = 3` (`delays: [0, 100, 300]`)

| Slot | `scheduledMs` | `actualValuesMs` (5 rodadas) | Mín (ms) | Mediana (ms) | p90 (ms) | Máx (ms) | Dif. Mediana (ms) | Dif. p90 (ms) | Dif. Máx (ms) |
|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 0 | 0 | `[2, 1, 1, 1, 1]` | 1 | 1 | 2 | 2 | +1 | +2 | +2 |
| 1 | 100 | `[101, 101, 100, 100, 101]` | 100 | 101 | 101 | 101 | +1 | +1 | +1 |
| 2 | 300 | `[301, 300, 300, 300, 301]` | 300 | 300 | 301 | 301 | 0 | +1 | +1 |

#### `N = 5` (`delays: [0, 100, 300, 600, 1000]`)

| Slot | `scheduledMs` | `actualValuesMs` (5 rodadas) | Mín (ms) | Mediana (ms) | p90 (ms) | Máx (ms) | Dif. Mediana (ms) | Dif. p90 (ms) | Dif. Máx (ms) |
|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 0 | 0 | `[2, 1, 1, 1, 1]` | 1 | 1 | 2 | 2 | +1 | +2 | +2 |
| 1 | 100 | `[101, 100, 100, 100, 100]` | 100 | 100 | 101 | 101 | 0 | +1 | +1 |
| 2 | 300 | `[301, 300, 300, 300, 300]` | 300 | 300 | 301 | 301 | 0 | +1 | +1 |
| 3 | 600 | `[601, 600, 600, 600, 600]` | 600 | 600 | 601 | 601 | 0 | +1 | +1 |
| 4 | 1000 | `[1001, 1000, 1010, 1000, 1000]` | 1000 | 1000 | 1010 | 1010 | 0 | +10 | +10 |

#### `N = 8` (`delays: [0, 100, 300, 600, 1000, 1500, 2000, 2500]`)

| Slot | `scheduledMs` | `actualValuesMs` (5 rodadas) | Mín (ms) | Mediana (ms) | p90 (ms) | Máx (ms) | Dif. Mediana (ms) | Dif. p90 (ms) | Dif. Máx (ms) |
|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 0 | 0 | `[2, 2, 1, 1, 1]` | 1 | 1 | 2 | 2 | +1 | +2 | +2 |
| 1 | 100 | `[101, 101, 100, 100, 101]` | 100 | 101 | 101 | 101 | +1 | +1 | +1 |
| 2 | 300 | `[301, 301, 300, 300, 300]` | 300 | 300 | 301 | 301 | 0 | +1 | +1 |
| 3 | 600 | `[602, 601, 600, 601, 600]` | 600 | 601 | 602 | 602 | +1 | +2 | +2 |
| 4 | 1000 | `[1002, 1001, 1000, 1000, 1001]` | 1000 | 1001 | 1002 | 1002 | +1 | +2 | +2 |
| 5 | 1500 | `[1502, 1501, 1500, 1500, 1500]` | 1500 | 1500 | 1502 | 1502 | 0 | +2 | +2 |
| 6 | 2000 | `[2001, 2001, 2001, 2000, 2000]` | 2000 | 2001 | 2001 | 2001 | +1 | +1 | +1 |
| 7 | 2500 | `[2501, 2501, 2500, 2500, 2500]` | 2500 | 2500 | 2501 | 2501 | 0 | +1 | +1 |

#### `N = 10` (`delays: [0, 100, 300, 600, 1000, 1500, 2000, 2500, 3000, 3500]`)

| Slot | `scheduledMs` | `actualValuesMs` (5 rodadas) | Mín (ms) | Mediana (ms) | p90 (ms) | Máx (ms) | Dif. Mediana (ms) | Dif. p90 (ms) | Dif. Máx (ms) |
|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 0 | 0 | `[4, 2, 1, 2, 1]` | 1 | 2 | 4 | 4 | +2 | +4 | +4 |
| 1 | 100 | `[101, 100, 100, 100, 100]` | 100 | 100 | 101 | 101 | 0 | +1 | +1 |
| 2 | 300 | `[301, 300, 300, 300, 300]` | 300 | 300 | 301 | 301 | 0 | +1 | +1 |
| 3 | 600 | `[604, 600, 600, 600, 600]` | 600 | 600 | 604 | 604 | 0 | +4 | +4 |
| 4 | 1000 | `[1001, 1000, 1000, 1000, 1000]` | 1000 | 1000 | 1001 | 1001 | 0 | +1 | +1 |
| 5 | 1500 | `[1501, 1500, 1500, 1500, 1500]` | 1500 | 1500 | 1501 | 1501 | 0 | +1 | +1 |
| 6 | 2000 | `[2001, 2000, 2000, 2000, 2000]` | 2000 | 2000 | 2001 | 2001 | 0 | +1 | +1 |
| 7 | 2500 | `[2501, 2500, 2500, 2500, 2500]` | 2500 | 2500 | 2501 | 2501 | 0 | +1 | +1 |
| 8 | 3000 | `[3001, 3000, 3000, 3000, 3000]` | 3000 | 3000 | 3001 | 3001 | 0 | +1 | +1 |
| 9 | 3500 | `[3501, 3500, 3501, 3500, 3501]` | 3500 | 3501 | 3501 | 3501 | +1 | +1 | +1 |
