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

## Colagem em cascata em várias abas (Edge)

A colagem em cascata empurra a mesma key confirmada para várias abas de resgate abertas e logadas, cada uma com um atraso configurado a partir do momento em que a oferta chega ao service worker da extensão. As abas mais recentemente acessadas recebem os menores atrasos. Por padrão, esse modo vem desligado.

1. **Carregar a extensão no Edge**: abra `edge://extensions`, ative o **Modo de desenvolvedor** e clique em **Carregar sem compactação** selecionando a pasta `browser-extension`. Copie o ID da extensão e registre o host nativo para o Edge com:
   ```powershell
   .\scripts\register-native-host.ps1 -ExtensionId ID_DA_EXTENSAO -Browser Edge
   ```
2. **Abrir as abas de resgate**: abra as *N* abas já logadas na conta Microsoft em `https://www.xbox.com/pt-BR/redeem` (ou localidade equivalente `xbox.com/<idioma>/redeem`). Caso tenha acabado de carregar ou recarregar a extensão, atualize as abas com F5 para que o frame de resgate se registre no worker.
3. **Ligar e desligar**: em `edge://extensions`, clique no link do **service worker** da extensão para abrir o console do DevTools e execute:
   ```js
   chrome.storage.local.set({cascade:{enabled:true, delays:[0,100,300,600,1000]}})
   ```
   Para desligar e voltar ao modo antigo (uma única aba ativa consultando a ponte), execute no mesmo console:
   ```js
   chrome.storage.local.set({cascade:{enabled:false}})
   ```
4. **Campo `activate`**: desligado por padrão (`activate: false`). Se incluído como `activate: true` no objeto `cascade`, a extensão traz para frente (`chrome.tabs.update(..., { active: true })`) a aba da vez imediatamente antes de preencher o campo.
5. **Limite de segurança**: a extensão faz no máximo **uma tentativa por key por aba**, preenche no máximo o **número de atrasos configurados em `delays`** (limitado a 10 abas e atraso máximo de 4000 ms) e **nunca aplica a mesma key duas vezes na mesma aba** (além de respeitar a guarda de 3 s após um preenchimento antes de aceitar outra key diferente naquela aba). Atenção: **cada aba além da que acertar o resgate conta como tentativa inválida na conta Microsoft**.
6. **Como ler o registro (`cascadeLog`)**: no console do service worker, consulte:
   ```js
   await chrome.storage.local.get('cascadeLog')
   ```
   Cada entrada traz a key mascarada (`XX…YY`), `tabId`, `slot`, `scheduledMs` (atraso configurado para o slot), `actualMs` (atraso real até o preenchimento na aba), `applyMs`, `result` (`'filled'`, `'expired'`, `'repeat'`, `'guard'`, `'no-field'`, `'error'`) e `page` (relatório enviado pela aba após `reportAfterMs`, padrão 1500 ms, com `fieldPresent`, `fieldHasKey`, `fieldDisabled` e trecho de `text` com a key mascarada).
7. **Teste automatizado local**:
   ```powershell
   node benchmarks\browser-cascade-test.mjs
   ```
   O teste copia a extensão para uma pasta temporária trocando a porta para `47993` e sobe a ponte HTTP de teste com `XKW_BRIDGE_PORT=47993` (sem pipe nativo), portanto não interfere no aplicativo instalado nem usa a porta padrão `47183`. Para medir memória e atraso por número de abas (`N` em 1, 3, 5, 8 e 10), use `node benchmarks\browser-cascade-test.mjs --sweep --out docs\cascata-sweep.json`.

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
