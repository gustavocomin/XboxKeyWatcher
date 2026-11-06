# XboxKeyWatcher

Lê keys Xbox (XXXXX-XXXXX-XXXXX-XXXXX-XXXXX) postadas como imagem num canal do WhatsApp e preenche o campo de resgate do Xbox no Chrome. Não faz login, não envia o formulário e não resgata nada por conta própria: a página da Microsoft pode iniciar o resgate sozinha quando o campo é preenchido.

Versão atual: **v3.4** (app) e **0.3.3** (extensão). O histórico das versões instaladas fica em `dist\win-x64\VERSION.txt`.

## Como funciona

Dois caminhos rodam juntos. O que tiver a key primeiro preenche o Chrome; o outro é descartado como repetido.

1. **Bots do canal** (caminho principal, `tools\wa-listener`): um bot por login do WhatsApp marcado nas Configurações (hoje a conta principal e a secundária, alternando as consultas). Cada bot ouve o post pelo push e também consulta a lista de posts do canal oficial (só lê os canais ativos de `canais.txt`):
   - **Consulta normal**: a cada 6 s por login (3 s alternando os dois) fora de horário agendado.
   - **Anúncio no canal** ("KEY … XBOX ⏳ Liberação de HH:MM"): abre um alerta com som no PC, envia mensagem da conta secundária para a principal no WhatsApp, grava o horário em `poll-rapido.txt` e agenda a **janela rápida** (500 ms por bot, de 2 min antes do horário anunciado até 10 min depois).
   - **Turbo na contagem** ("PREPARADOS???", "3..."): dispara 2 consultas simultâneas a cada 500 ms por bot (~125 ms somando os dois logins) até 30 s depois da primeira imagem do canal (ou 2 min no máximo). Se uma consulta der erro no turbo, ele encerra o turbo daquela janela e segue no ritmo rápido normal (500 ms) 1 s depois.
   - **OCR**: baixa a imagem e lê a key com RapidOCR, aceitando só quando duas leituras concordam (imagem inteira e linha ampliada 2x; ou desempate numa 3ª leitura quando diferem apenas por letras fora do alfabeto Xbox). Recusa keys com caracteres que códigos Xbox não usam (A, E, I, O, U, L, S, 0, 1, 5).
2. **Leitura pela tela** (reserva): lê a janela do WhatsApp Desktop com Windows OCR, RapidOCR e Tesseract.

A key vai para a área de transferência e, pela ponte nativa, para a extensão do Chrome, que preenche o campo de resgate.

Medições de 05/11/2026 (WhatsApp real): no canal de teste, a key chegou ao app 1,4–1,7 s depois do post, e o Chrome foi preenchido ~10 ms depois disso. No canal oficial, o post chega em ~1,2 s pela consulta, contra 8–10 s pelo push. Detalhes em [docs/perf-bot-2026-11-05.md](docs/perf-bot-2026-11-05.md).

## Uso a cada sorteio

1. Abra o app (atalho **XboxKeyWatcher** no menu Iniciar ou na Área de Trabalho, ou `dist\win-x64\XboxKeyWatcher.App.exe`). Ele conecta sozinho a janela do WhatsApp Desktop e liga a colagem no Chrome.
2. O horário pode vir sozinho do anúncio do canal (gravado em `poll-rapido.txt` quando os bots estão ouvindo) ou ser definido em **Configurações > Horário do sorteio** (**Usar horário do sorteio**, data e hora da key).
3. Deixe o WhatsApp Desktop aberto e **não minimizado**, e a aba `https://www.xbox.com/pt-BR/redeem` aberta e visível no Chrome.

O resto é automático. Com a key às 10:00 e os tempos padrão:

| Horário | O que acontece |
|---|---|
| 9:55 | Os bots estão ligados e com o OCR preparado (se havia horário futuro agendado manualmente, aguardam só no push até 9:58; se veio pelo anúncio do canal, seguem consultando a cada 6 s até 9:58). |
| 9:58 | Consulta rápida ao canal oficial a cada 500 ms por bot (as duas contas se alternam) e leitura pela tela ligada. Na contagem ("PREPARADOS???" / "3..."), entra o turbo (2 consultas simultâneas por bot a cada 500 ms até 30 s após a imagem). |
| 10:10 | A leitura pela tela desliga. Horário já passado não desliga mais os bots: sem outro horário futuro pela frente, eles continuam ligados consultando a cada 6 s para pegar o próximo anúncio. |

Sem horário futuro cadastrado (ou depois que o horário anunciado já passou), os bots ficam ligados o tempo todo e consultam o canal a cada 6 s por bot (3 s alternando as duas contas). A leitura pela tela, fora de horário agendado, também pode ser ligada pelo botão **Iniciar**.

## Configurações

- **Canais**: tabela com Ativo, Nome e Link. Desmarcar **Ativo** faz o bot parar de escutar o canal sem apagá-lo. O canal **oficial** é o primeiro ativo da lista: é o único que o bot consulta. Salvar reinicia os bots.
- **Horário do sorteio**: data e hora da key, e os três tempos (bots antes, consulta rápida e tela antes, fim depois).
- **Contas do bot**: os logins do WhatsApp em que os bots rodam (pastas `auth-*`). Não marque um login que outro bot usa fora do app: duas sessões do mesmo login se derrubam.
- **Atalhos**: atalhos globais (padrão Ctrl+Alt+Shift+F9 iniciar/parar a leitura pela tela, F10 forçar OCR, F11 copiar a última key, F12 abrir a janela).

Esses valores ficam em `tools\wa-listener` (`canais.txt`, `poll-rapido.txt`, `agenda.json`, `conta.txt`) e em `dist\win-x64` (`settings.json` com a janela e a região da tela, `hotkeys.json`).

## Primeira instalação

1. **Extensão**: em `chrome://extensions`, ative o modo de desenvolvedor e carregue a pasta `browser-extension` como extensão sem compactação. Copie o ID dela e rode `scripts\register-native-host.ps1 -ExtensionId ID_DA_EXTENSAO` (para o Edge, acrescente `-Browser Edge`). A extensão não tem botões: ela fica sempre ligada na página de resgate do Xbox.
2. **Logins do WhatsApp**: com o app fechado, rode `tools\wa-listener\parear-principal.cmd` (ou `iniciar-bot.cmd` para a secundária) e escaneie o QR em WhatsApp > Aparelhos conectados. Depois marque o login em Configurações > Contas do bot.
3. **Janela e região da tela**: no app, clique em **Selecionar janela**, escolha a janela do WhatsApp Desktop e arraste na prévia sobre a coluna de mensagens. A escolha é salva; nas próximas aberturas o app conecta sozinho.

Depois de atualizar a extensão: recarregue-a em `chrome://extensions` e dê F5 na aba de resgate do Xbox.

## Desenvolvimento

Requisitos: .NET SDK 8+, Python 3.13 (em `.venv`), Node 22 (dependências em `tools\wa-listener\node_modules`) e **PowerShell 7** (o Windows PowerShell 5.1 falha no primeiro passo dos testes).

```powershell
pwsh -File .\scripts\install-dev.ps1   # dependências Python, Zig e modelo Tesseract
pwsh -File .\scripts\test.ps1          # suíte completa
pwsh -File .\scripts\build.ps1         # recompila dist\win-x64
```

- A suíte reescreve `benchmarks\results`; restaure com `git checkout -- benchmarks/results`. Os testes de tela do CaptureBenchmark falham de vez em quando sem motivo; rode de novo antes de investigar.
- Todo arquivo `.cs` novo do app precisa entrar na lista de Compile de `benchmarks\CaptureBenchmark\CaptureBenchmark.csproj`.
- Teste da extensão num Edge separado: `node benchmarks\browser-extension-test.mjs --local-http`.
- A/B do OCR do bot: `node tools\wa-listener\ocr-ab.mjs --a base --b <variante> --real <pasta> --rounds ABBA`. Imagens de teste com keys fictícias: `tools\wa-listener\make-test-images.ps1` e `benchmarks\generate_safety.py`.
- Nunca rode um bot de teste com um login que o app está usando: feche o app antes.

## Logs

- Bots: `tools\wa-listener\logs\listener-*-<login>.jsonl` (chegada do post, download, OCR, consultas por minuto, erros).
- App: `%LOCALAPPDATA%\XboxKeyWatcher\detections.jsonl` (cópias, preenchimentos no Chrome e recusas).

Keys aparecem nos logs só com os 2 primeiros e os 2 últimos caracteres.

## Limitações conhecidas

- O tempo que falta cortar está quase todo no download da imagem nova (0,3–1,4 s até o 1º byte), que depende do servidor do WhatsApp.
- Em fontes muito condensadas, as duas leituras podem concordar em 7 lido como Z. Nas imagens reais do canal isso não aconteceu.
- Consultar o canal rápido demais leva o WhatsApp a recusar as consultas (visto a 3 por segundo depois de ~30 min). Por isso a consulta rápida fica só na janela do sorteio. Se o WhatsApp recusar, o bot pausa a consulta e continua pelo push.
- A leitura pela tela não funciona com o WhatsApp Desktop minimizado.
