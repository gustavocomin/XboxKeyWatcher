# Bot do canal para a key de sexta (06/11/2026)

Branch `perf/sexta` (worktree `C:\Repos\XKW-sexta`), a partir de `ae22730`. Só os arquivos do bot
mudam (`tools\wa-listener`); app, host nativo e extensão ficam como estão. Keys aparecem só com
os 2 primeiros e os 2 últimos caracteres.

Origem dos números:
- **WhatsApp real**: histórico do canal oficial (consulta de leitura, a mesma do WhatsApp Web),
  logs dos bots ao vivo (`tools\wa-listener\logs`) e o ensaio com os bots da cópia nos canais de
  teste, com keys fictícias.
- **Bancada**: imagens reais de key (a key de Xbox de 04/11 e 20 imagens dos canais de teste), a
  imagem da key de PS5 de 05/11 (sem key Xbox) e o corpus fictício `generate_safety.py`
  (sementes 7, 11 e 13; 1572 imagens).

## Como a key sai (WhatsApp real, canal oficial)

| | Xbox 04/11 | PS5 05/11 |
|---|---|---|
| Aviso "KEY GTA 6 … ⏳ Liberação de HH:MM" | 17:15:10 (para 17:30) | 10:23:17 (para 10:38) |
| "PREPARADOS???" | 17:30:37 | 10:38:53 |
| "3...", "2...", "1..." | 17:30:41–44 | 10:39:02–06 |
| **Imagem da key** (1599×899, "🚨 KEY GTA 6 …") | **17:30:50** | **10:39:15** |
| "Key de hoje já Resgatada" | 17:34:29 | 10:42:20 |

- A key é um **post novo de imagem**, 50–75 s depois da hora anunciada e 6–9 s depois do "1...".
- Sexta é dia de Xbox: "AMANHÃ a KEY é de XBOX … Será enviada pela TARDE (na primeira metade da
  tarde)" (05/11 11:10).
- O canal edita posts (`edit="3"`, mesmo id do servidor) e apaga (`edit="8"`); nas duas keys
  nenhuma das duas coisas aconteceu.

## O que mudou no bot (`listener.mjs`, `bot-ocr.mjs`, `channel-signals.mjs`, `app-inbox.mjs`)

| # | Mudança | Evidência | Risco p/ 1ª leitura / segurança |
|---|---|---|---|
| 1 | Consulta rápida automática: aviso "KEY … XBOX … Liberação de HH:MM" liga 500 ms de HH:MM−2 a +10; "PREPARADOS"/"3..." liga por 3 min; edições do aviso são relidas; 1ª consulta após ligar pega 10 posts | 894 posts reais: 2 avisos Xbox e 16 de contagem detectados, 0 falsos; ensaio real: troca para 500 ms em 0,3 s, edição lida, aviso recuperado após reinício | Só muda a frequência de consulta; nunca aceita key por edição |
| 2 | Envio ao app com nova tentativa por 2,5 s | Ensaio real: ping de um dos bots falhou com ENOENT em 3 de 3 subidas e na maioria dos ciclos de 30 s (pipe do app atende uma conexão por vez) | Nenhum; o app deduplica |
| 3 | Só canais ativos de `canais.txt` | Ensaio real: posts de 2 canais fora da lista eram lidos pelo bot atual | Nenhum |
| 4 | Worker de OCR reinicia sozinho; erro inesperado não derruba o bot; consulta com tempo limite de 4 s; imagem >10000 px recusada | Código + 3 testes com o worker real | Nenhum |

**Não mudou**: trava de borda segue desligada (a key real de 02/11 fica a 8 px da borda; folga de 0,8% a recusaria; no corpus a regra de 1 px não pegou erro novo).

## Resultados
- Ensaio (WhatsApp real, canal de teste, keys fictícias, 2 bots): post→app 1,37 s (rodada 1) e ~1,2 s (rodada 2) a partir do segundo do post (real ≈ 0,5 s menor). Antes (sessão anterior, poll 2 s): 1,42–1,74 s.
- Bancada: 22/22 keys reais lidas, 0 erradas; OCR antigo × novo (A B B A, 15 s ocioso): medianas 125/124/121/128 ms.
- Suíte `scripts\test.ps1` (com 15 testes novos do bot) e teste da extensão no Edge de teste passaram.

## Sexta
- Não cadastrar horário (deixar "Usar horário do sorteio" desmarcado): o bot liga a consulta rápida pelo aviso. Abrir o app ao meio-dia.
- Quando o aviso sair: conferir na linha dos bots "Key anunciada no canal para HH:MM"; ligar a leitura pela tela (Iniciar).
- Aba `xbox.com/pt-BR/redeem` aberta, logada, ativa e recarregada; relógio do Windows sincronizado.
