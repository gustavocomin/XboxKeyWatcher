# Medições experimentais — 2 e 3 de novembro de 2026

## Captura até preenchimento local

Compile com `dotnet build benchmarks/CaptureBenchmark -c Release` e execute `node benchmarks/browser-extension-test.mjs --end-to-end` com a sessão gráfica desbloqueada. O Edge precisa ter o host nativo registrado para a extensão. Feche outra instância com colagem assistida ativa antes do ensaio. O teste alterna duas chaves fictícias, usa a captura e o OCR do aplicativo, confirma o clipboard do Windows e verifica o valor preenchido em um formulário local do Edge headless. O clipboard isolado do Edge recebe o valor esperado antes de cada rodada. O teste restaura o clipboard do Windows quando ele ainda contém um dos valores da bancada.

A série de 20 rodadas teve 20 preenchimentos exatos, média de 93,33 ms, p50 de 87,53 ms e p95 de 132,88 ms, do início do desenho à confirmação do preenchimento. A medição usa o mesmo relógio do aplicativo para os dois extremos. As chaves fictícias foram desenhadas em uma janela WinForms. A série não mede o WhatsApp nem o site do Xbox.

O worker registra conversão BGRA, detecção, reconhecimento e o restante do processamento interno. A diferença para o tempo no C# inclui transferência, espera pelo worker e leitura da resposta. Nas 20 cópias da série, houve uma chamada ao RapidOCR por cópia. As medianas foram 0,14 ms de conversão, 19,80 ms de detecção, 25,92 ms de reconhecimento, 0,69 ms de outros passos internos e 0,57 ms no restante da ida e volta.

Uma imagem anexada pelo usuário foi avaliada separadamente em memória, no tamanho original e reduzida para 475 e 330 pixels de largura. Foram dez repetições de cada tamanho, sem preenchimento. Nenhuma passou no critério completo de leitura segura. Uma sondagem isolada do RapidOCR retornou o código exato nos três tamanhos. A proteção de borda sinalizou o original e a versão de 330 pixels. Na versão de 475 pixels, as medianas do RapidOCR foram 24,31 ms de detecção, 29,19 ms de reconhecimento, 0,15 ms de conversão, 0,34 ms de outros passos internos e 0,63 ms no restante da ida e volta. A imagem e o código do exemplo ficaram fora do repositório.


A investigação reproduziu o bloqueio de 475 pixels. O Windows OCR e o RapidOCR concordaram na chave, mas só a caixa do Windows OCR foi sinalizada pela proteção de borda. A correção permite uma releitura em alto contraste quando as caixas se sobrepõem, o RapidOCR indica margem livre e as duas leituras são idênticas. A miniatura passou de 0/10 para 10/10 em memória. O original e a versão de 330 pixels continuaram rejeitados. Em 116 imagens de controle, incluindo seis recortes laterais da mesma miniatura, as decisões permaneceram iguais e não houve aceitação incorreta.

Na recuperação de uma leitura sinalizada junto à lateral, a faixa enviada ao RapidOCR agora usa uma margem proporcional à altura da linha. A região completa continua disponível como segunda tentativa. Na miniatura de 475 pixels, com 15 repetições por versão, a mediana do OCR caiu de 74,09 para 61,53 ms, o p95 de 142,35 para 131,71 ms e a mediana do RapidOCR de 55,05 para 42,72 ms. As 136 observações de controle tiveram as mesmas decisões e zero falsas aceitações. O p95 do conjunto independente passou de 231,38 para 254,66 ms nesta comparação. A variante que encolhia a faixa para todas as leituras rejeitadas chegou a 294,45 ms no mesmo conjunto e foi descartada. As medições são em memória.

### Replay de rolagem com miniaturas comprimidas

Execute `node benchmarks/browser-extension-test.mjs --scroll-replay` após compilar o benchmark. O cenário desenha uma miniatura JPEG fictícia que entra pela borda inferior da janela. Alterna quadros que ficam na tela e quadros que desaparecem após 120 ms. O relógio começa antes de desenhar a primeira posição com a linha inteira visível e termina na confirmação do campo local do Edge.

Em 12 rodadas por configuração, todas preencheram as 12 chaves corretamente. A média foi de 152,87 ms na referência e 175,18 ms ao buscar primeiro nas linhas alteradas. A versão final, que pula a busca ampla apenas quando o OCR ainda não confirmou uma chave e já existe outro quadro na fila, chegou a 125,49 ms. O p95 amostral passou de 312,73 para 192,62 ms. A amostra tem só seis aparições breves por configuração e não substitui um teste no WhatsApp real.

### Tempo após liberar o campo

O teste `node benchmarks/browser-extension-test.mjs --field-ready` usa o Edge isolado e uma oferta fictícia disponível enquanto o campo está ocupado. Mede no próprio navegador desde limpar o campo e emitir o evento de entrada até a extensão preencher a chave. Em 24 amostras por versão, a mediana caiu de 64,75 para 2,40 ms e o p95 de 127,10 para 2,80 ms. O valor é específico desse cenário e não identifica a causa do atraso no Chrome real.

### Log por oferta e por chamada de OCR

`OfferId` liga a cópia ou reoferta ao preenchimento. `Delivery` separa a oferta até a ponte começar a responder da resposta até a confirmação. Em `Delivery.Browser`, `QueryMs` inclui o tempo em que a consulta ficou aguardando uma oferta, e `NativeQueryMs` é a parte da consulta que passou pelo host nativo. `ValidateMs` mede as verificações no navegador antes de preencher e `ApplyMs` mede a escrita do valor e o evento de entrada. `SinceLastUnavailableMs` indica o intervalo desde a última observação de campo indisponível, quando observado. Esses intervalos se sobrepõem e não devem ser somados.

No OCR do Windows, `WindowsFirstPassMs`, `WindowsResizeMs` e `WindowsSecondPassMs` distinguem a leitura inicial, o preparo da imagem ampliada e a segunda leitura. `RapidPhases.Details` mostra cada chamada, com dimensões, fila, inicialização, escrita, espera e leitura da resposta, decodificação e tempos internos do worker. `TextRegions` conta quantos recortes foram enviados ao reconhecedor. A espera pela resposta contém a execução do worker e, por isso, se sobrepõe aos tempos internos.

### Lotes do reconhecedor em quadros carregados

O filtro geométrico em ensaio reduziu a mediana de 14 para 6,5 regiões reconhecidas e o tempo mediano de reconhecimento de 148,07 para 97,44 ms em 24 quadros carregados. Nenhuma versão aceitou as chaves desse conjunto, por isso esse ensaio não demonstrou que descartar regiões preserva a leitura nesse cenário. Num segundo conjunto carregado, as 12 imagens com chave foram lidas pelas duas versões e as seis sem chave ficaram sem aceitação.

A versão adotada mantém todos os recortes e passa a usar lotes de duas linhas apenas quando há mais de seis regiões. O modelo ordena os recortes por proporção e preenche cada lote até a largura do maior. Lotes menores reduzem esse preenchimento. Nos 24 quadros carregados, a mediana do OCR total caiu de 354,04 para 312,56 ms e o p95 de 570,30 para 496,47 ms. As decisões coincidiram em 280 observações, incluindo miniaturas completas, cortes e quadros sem chave. No segundo conjunto carregado, o p95 caiu de 476,39 para 434,73 ms e a mediana subiu de 56,49 para 61,98 ms. São medidas em memória.

## Otimizações de latência

### Confirmação localizada no RapidOCR

O reconhecimento direto da linha foi comparado com o commit `c9f17a0` em três conjuntos fictícios, com dez leituras por imagem. Ele manteve os mesmos acertos e zero falsos positivos. No conjunto difícil, a mediana das leituras corretas caiu de 80,94 para 51,17 ms, mas o p95 delas subiu de 127,04 para 153,15 ms. O p95 de todas as leituras subiu de 158,02 para 170,63 ms. No replay do canal subiu de 100,84 para 106,06 ms e no holdout de 177,88 para 186,54 ms. O holdout teve zero acertos em ambas as versões. O experimento foi descartado.

### Entrega à extensão com espera por nova oferta

O teste `node benchmarks/browser-extension-test.mjs --measure` executou 30 entregas fictícias por configuração, com a mesma sequência de intervalos entre ofertas e o campo vazio. A medição vai da oferta do aplicativo à confirmação pelo navegador Edge isolado. A mediana caiu de 66,08 para 49,72 ms e o p95 de 129,38 para 100,86 ms. A variante aguarda a próxima oferta na ponte por até 600 ms e responde assim que ela chega. Também passaram os casos de aba diferente, foco em outro campo e clipboard alterado. O teste exclui captura, OCR e tempo de resposta do site do Xbox.

### Ampliação, fila de captura e threads

Pular a ampliação quando a primeira leitura do Windows OCR não detectava linhas manteve a contagem de acertos nos conjuntos testados, mas piorou o p95 no conjunto difícil de 158,02 para 170,28 ms e no sintético básico de 112,71 para 124,97 ms. A variante foi descartada.

Em dez rodadas de scroll sintético, uma fila de dois quadros leu quatro chaves exibidas por 48 ms, contra zero com o quadro mais recente. As duas versões leram os dez quadros finais. O maior tempo dos quadros finais subiu de 565,17 para 738,37 ms. A fila não foi adotada.

No OCR completo em memória, 4, 6 e 8 threads mantiveram 50/120 acertos no conjunto difícil, com p95 de 157,90, 157,55 e 153,86 ms. No replay do canal, as três mantiveram 10/20 acertos e os p95 foram 96,46, 99,50 e 122,41 ms. A configuração permaneceu em quatro threads.

### Reuso da confirmação por pixels idênticos

Quatro chaves fictícias foram desenhadas em regiões de 1200 × 600. Cada região teve cinco variações que mudavam apenas um retângulo no topo, fora do recorte da chave. Em três execuções com uma leitura por imagem, ambas as versões acertaram 72/72, sem falsos positivos. Nas 60 leituras após a primeira imagem de cada chave, a mediana caiu de 100,08 para 58,66 ms e o p95 de 129,87 para 67,20 ms. Considerando também as 12 primeiras leituras, a mediana caiu de 100,92 para 59,34 ms e o p95 subiu de 143,82 para 153,81 ms. As primeiras leituras não usam o cache. No conjunto difícil, a variante manteve 50/120 acertos, zero falsos positivos e p95 de 157,62 ms. São tempos de OCR em memória.

### Comparação antes de alocar o recorte

O teste `dotnet run --project benchmarks/OcrBenchmark -c Release -- --compare-crop` compara o recorte de 1100 × 800 de um quadro de 1920 × 1032 em memória. Em duas execuções de 200 iterações por configuração, a mediana de quadros iguais caiu de 0,55–0,67 ms para 0,12–0,15 ms e a alocação por quadro caiu de 3.520.024 bytes para zero. As mudanças no topo e na base continuaram sendo detectadas, com diferença máxima de 0,011 ms entre as medianas pareadas. A medida cobre apenas a comparação e o recorte em CPU. A transferência da janela inteira da GPU permanece no caminho de captura.

## Continuação: corpus independente e limites

Em 3 de novembro de 2026, o conjunto difícil anterior passou de 40/120 para 50/120 observações aceitas, sem falsos positivos nessa execução, média 103,27 ms e p95 152,80 ms em memória. São dez repetições de cada uma de 12 imagens, não 120 imagens independentes.

Um conjunto novo com 48 miniaturas fictícias e dez repetições por imagem teve, no monitoramento em memória: 20/120 observações de texto completo aceitas; 0/120 junto à borda; nenhuma cópia em 120 observações cortadas e nenhuma em 120 sem key. Não houve cópia incorreta nessa amostra. No baseline, uma das 12 imagens cortadas passou inicialmente despercebida em todas as dez repetições; após corrigir a detecção de sequência incompleta do RapidOCR, a reexecução do conjunto passou. Ele foi usado na correção e deixou de ser validação independente. O conjunto é sintético e pequeno; não demonstra precisão no WhatsApp. As verificações adicionais para O/0 e I/1 reduzem risco observado, mas também rejeitam leituras válidas e não eliminam outras confusões.

O teste de integração com clipboard real passou com duas imagens fictícias em 152,60 e 188,30 ms, medidos desde o desenho controlado até a confirmação; o clipboard anterior foi restaurado. O Release foi compilado, mas o fluxo permanece experimental e os critérios de aceitação ainda não foram cumpridos.

## Estado anterior e conjunto difícil

Os números históricos abaixo que mencionam apenas Windows OCR e proteção de borda precedem a confirmação cruzada atual e não descrevem a latência atual da aplicação. No conjunto de 12 imagens fictícias difíceis, dez repetições por imagem, o baseline atual acertou 40/120 observações, bloqueou 80/120 por dúvida, apresentou zero falsos positivos e zero casos de imagem antiga omitida com baseline liberado. Média 102,50 ms, p50 89,71 ms, p95 156,51 ms, p99 191,31 ms. Na busca em monitoramento, foram 40/120 aceitas, zero falsos positivos, média 99,24 ms, p50 103,53 ms, p95 154,46 ms, p99 172,29 ms. São medições em memória, sem captura ou clipboard; repetições não são imagens independentes.

O RapidOCR isolado no mesmo conjunto e com quatro threads acertou 36/36 observações, média 47,59 ms, p50 39,40 ms, p95 86,02 ms, p99 86,22 ms, uso médio 295% de um núcleo e pico de 134,5 MiB. O worker persistente via IPC registrou 36/36, média 50,81 ms, p50 40,92 ms, p95 90,24 ms e p99 90,38 ms; inicialização 743 ms. Os modelos e a entrada diferem dos benchmarks antigos. A confirmação cruzada reduz aceitação mas evita alguns erros; nenhum desses resultados prova precisão geral. Memória e CPU do benchmark C# não incluem o processo RapidOCR, portanto não representam o total do aplicativo.

No teste mais recente do próprio formulário com clipboard real, duas keys fictícias foram copiadas em 393,37 e 294,50 ms, com polling de até 30 ms, depois de registrar uma key antiga sem copiá-la. O clipboard anterior foi restaurado. Duas observações não permitem estimar percentis; a medição começa na alteração sintética, não no aparecimento físico no monitor. O caminho Python PrintWindow + Tesseract + clipboard acertou 30/30, média 69,06 ms, p50 66,41 ms, p95 79,62 ms, p99 79,79 ms; usa outra captura e motor e não é comparação direta da aplicação.

Máquina: Ryzen 7 5700X, RTX 2060, cerca de 48 GiB de RAM, Windows x64. Idioma Windows OCR: pt-BR. Valores são de execuções locais, com imagens e códigos fictícios; não são garantias. Resultados brutos e comandos reexecutáveis ficam em `benchmarks/results` e `scripts/benchmark.ps1`.

## OCR isolado, imagens em memória

Seis imagens sintéticas (texto claro, fundos e tamanhos variados, incluindo JPEG); dez repetições por imagem. Não são 60 imagens independentes. P95 e P99 são percentis por observação; p99 numa amostra de 60 é o máximo observado. Os valores de CPU são percentuais de um núcleo, medidos durante a execução; a memória é o pico de working set do processo inteiro.

| Motor / configuração | Leituras corretas | Falsos positivos | Média ms | p50 ms | p95 ms | p99 ms | CPU um núcleo | Pico memória |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| C# Windows OCR, bicúbica 2× quando necessário e proteção de borda | 60/60 | 0 | 5,17 | 3,19 | 16,24 | 16,70 | 110% | 108,6 MiB |
| Python RapidOCR padrão | 50/60 | 0 | 490,54 | 482,36 | 541,96 | 563,85 | 802% | 679,8 MiB |
| Python RapidOCR, limite de detecção e sem classificador de rotação | 60/60 | 0 | 52,02 | 45,71 | 115,07 | 117,92 | 1411% | 126,7 MiB |
| Python + Tesseract nativo, PSM 7 | 20/60 | 0 | 15,00 | 14,78 | 26,82 | 27,15 | 101% | 47,1 MiB |
| Python + Tesseract nativo, PSM 6 | 40/60 | 0 | 39,77 | 26,57 | 72,35 | 73,56 | 100% | 47,5 MiB |

Esses resultados comparam configurações e motores diferentes, não o custo intrínseco das linguagens. Tesseract PSM 7 pressupõe uma linha e não equivale a localizar texto numa conversa inteira. O RapidOCR padrão falhou no JPEG comprimido, e a primeira versão do Windows OCR, sem ampliação, falhou na imagem pequena. O fallback bicúbico recuperou aquela imagem neste conjunto. Não há imagens reais ou códigos válidos no conjunto.

Como comparação adicional com o **mesmo** motor Tesseract e PSM 6, executáveis nativos carregaram os mesmos seis arquivos RGB em memória: C teve 40/60 acertos, média 39,13 ms, p50 26,07 ms, p95 71,48 ms e p99 73,37 ms; C++ teve 40/60, média 39,04 ms, p50 23,41 ms, p95 71,14 ms e p99 71,73 ms. A ligação Python com esse motor teve 40/60, média 39,77 ms e p95 72,35 ms na execução listada acima. Não inclui captura de tela ou clipboard, e os dados de origem são sintéticos.

## Comparação de pixels

Dois buffers de 540.000 bytes, 10.000 comparações, metade iguais e metade diferentes no último byte. As medições incluem chamadas ao relógio e usam implementações de biblioteca diferentes. P95: C `memcmp` compilado com Zig 0,240 ms; C++ com a mesma implementação 0,248 ms; C AVX2 0,0075 ms; C# `Span.SequenceEqual` 0,0172 ms; Python comparação de buffers 0,0167 ms. AVX2 é detectado antes da execução. A comparação nativa é somente um estágio, não o pipeline de reconhecimento, e não autoriza concluir que uma linguagem é mais rápida em geral. Os executáveis de comparação ficam em `benchmarks/native` após o script.

## Captura e integração

Uma janela WinForms sintética, Windows Graphics Capture e Windows OCR: 30 amostras entre a conclusão do desenho e o retorno correto do OCR, média 31,28 ms, p50 31,99 ms, p95 40,13 ms e p99 40,92 ms. Não inclui escrita no clipboard e não mede o aparecimento físico no monitor. Trinta amostras ainda são insuficientes para estimar p99 confiável.

Antes da inclusão da proteção de borda e da cópia explícita do bitmap, uma janela sintética de 1920×1032 produziu 30 leituras com média 44,29 ms, p50 43,35 ms, p95 55,76 ms e p99 61,03 ms. Essa execução anterior não representa o pipeline atual.

Após incluir a cópia do bitmap, o recorte e a proteção de borda, uma execução de 100 amostras com janela sintética de 1920×1032, intervalo de 200 ms e sem clipboard teve média 58,05 ms, p50 59,53 ms, p95 65,88 ms e p99 73,41 ms. Não inclui baseline, detecção de mudança ou interface do aplicativo. O resultado bruto é `benchmarks/results/csharp-full-size.json`.

Uma única captura da região real do WhatsApp de 1460×950 foi reutilizada 30 vezes em memória, sem salvar imagem ou texto: o OCR com proteção teve média 40,58 ms, p50 40,49 ms, p95 42,28 ms, p99 42,74 ms e pico do processo de 144,5 MiB. A proteção rejeitou em 30/30 leituras a sequência encostada numa borda vertical forte, cuja leitura divergiu do exemplo fornecido. Trata-se de uma única imagem repetida, não de 30 imagens independentes nem de uma taxa geral de precisão. Resultado em `benchmarks/results/whatsapp-ocr-metrics.json`.

Implementações nativas C e C++ também foram medidas com sua própria janela sintética, captura `PrintWindow` e Tesseract PSM 6. C: 30/30 leituras, média 66,58 ms, p50 66,63 ms, p95 67,11 ms e p99 69,09 ms; C++: 30/30, média 66,59 ms, p50 66,60 ms, p95 67,26 ms e p99 68,71 ms. Este tempo começa **antes da solicitação de desenho** e termina no OCR, sem clipboard. A comparação direta com C# é limitada: janelas, API de captura, mecanismo OCR e início da medição são diferentes. Não se avaliou `PrintWindow` com o WhatsApp encoberto e esse método não é orientado por frames.

Um teste somente de aquisição da janela real do WhatsApp, sem alterar o foco ou salvar conteúdo, obteve um frame 1920×1032, com variação de luminância e janela sem foco e não minimizada. A primeira aquisição fria levou cerca de 313 ms; isso não é latência de frame em regime. Não foram testadas oclusão parcial específica nem janela minimizada.

Após desbloqueio, um teste com escrita Win32 na thread de interface confirmou 30/30 cópias de texto fictício, com média 29,67 ms, p50 28,25 ms, p95 41,81 ms e p99 46,10 ms desde a conclusão do desenho. Os dados estão em `benchmarks/results/csharp-integrated-ui-thread-success.json`. Uma execução posterior com escrita em thread de trabalho confirmou 30/30, média 34,35 ms, p50 33,85 ms, p95 46,02 ms e p99 67,15 ms; ela precedeu a inclusão da proteção de borda e não inclui baseline nem a interface principal. A medição não é desde o aparecimento físico na tela e tem amostra pequena.

O teste do `MainForm` real, com janela fictícia e clipboard real, registrou uma key antiga sem copiá-la, copiou duas keys novas consecutivas e não voltou a copiar a antiga ao reaparecer. As duas durações observadas foram 52,70 ms e 72,65 ms, com polling de 30 ms incluído: são apenas evidência funcional, não percentis. Há cenários adicionais com destino simulado para o recebimento durante um baseline artificialmente atrasado, e para uma imagem cortada. Arquivos: `app-integration.json`, `app-during-baseline.json`, `app-clipped.json`.

Em janela fictícia estática, o `MainForm` permaneceu monitorando durante 60,76 segundos, sem encaminhar a key do baseline ao destino simulado. O processo combinado da janela de teste e do aplicativo consumiu 0,90% de um núcleo; o working set variou de 114,5 a 116,6 MiB. O resultado está em `app-soak.json`. Um minuto não demonstra estabilidade por vários minutos nem cobre o WhatsApp real.

O mesmo programa nativo C e C++, usando `PrintWindow`, Tesseract e clipboard Win32 na janela sintética, confirmou 30/30 cópias: C média 66,17 ms, p50 66,32 ms, p95 68,45 ms e p99 69,42 ms; C++ média 67,50 ms, p50 66,34 ms, p95 75,57 ms e p99 77,03 ms. A medição começa na solicitação de desenho, e não após a conclusão, e não inclui a aplicação C# nem seu detector de bordas. O caminho equivalente em Python com `PrintWindow` e Tesseract, sem clipboard, teve 30/30 acertos e p95 68,43 ms; a medição com clipboard está no início deste documento.
