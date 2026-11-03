# XboxKeyWatcher

**Estado: experimental e ainda não validado para uso real.** Testes sintéticos do aplicativo passaram com baseline, duas novas keys e clipboard real. No conjunto sintético difícil original, o pipeline reconheceu 50 de 120 observações; em outro conjunto, reconheceu somente 20 de 240 observações de imagens com key completa ou próxima à borda. Uma imagem cortada inicialmente não foi sinalizada pelo baseline; a falha específica foi corrigida e incluída nas regressões. A leitura da imagem real do WhatsApp foi rejeitada mesmo após ser aberta. Não confie nele para acompanhar uma promoção. O baseline verifica também com RapidOCR e bloqueia divergências, mas OCR pode deixar de identificar uma imagem antiga.

## Aplicativo experimental

Executável autossuficiente x64: `dist\win-x64\XboxKeyWatcher.App.exe`. Mantenha toda a pasta `dist\win-x64` junta: ela inclui RapidOCR e Tesseract. O aplicativo usa Windows Graphics Capture, Windows OCR, RapidOCR e Tesseract localmente; é necessário um idioma de OCR do Windows instalado. Para calibrar, selecione a janela, arraste o mouse na prévia sobre a coluna de mensagens e clique em **Testar OCR**. A seleção fica visível em verde e é salva junto ao executável, sendo reaplicada apenas após a seleção de uma janela com o mesmo título e tamanho. **Testar OCR** não copia nada. **Testar clipboard** copia um texto fictício mediante clique. **Iniciar experimental** estabelece um baseline e tenta copiar novas leituras. A janela pode ser minimizada para a bandeja; clique duas vezes no ícone para restaurar.

O OCR é aquecido ao escolher a janela. Uma heurística rejeita candidatos próximos de bordas que possam cortar caracteres, ou com formato incompleto; o baseline é interrompido se detectar uma dessas situações. Essa heurística é conservadora e não identifica todos os erros possíveis. Se a primeira letra realmente estiver fora da imagem, o programa não tem como recuperar os pixels ausentes nem deve adivinhar a letra.

Ainda é necessário selecionar a janela novamente ao iniciar; não há redetecção por handle persistido. O aplicativo não resgata códigos, acessa contas ou envia dados. Captura só o item escolhido no seletor do Windows, mas o seletor também pode oferecer monitores: escolha explicitamente a janela do WhatsApp. Captura com janela minimizada não foi validada. Em caso de redimensionamento, selecione a região novamente. A interface experimental não representa a entrega final pretendida.

Os atalhos padrão são Ctrl+Alt+Shift+F9 (iniciar/parar), F10 (forçar OCR), F11 (recopiar) e F12 (abrir interface), todos com os mesmos três modificadores. O botão **Atalhos** permite alterar as combinações e informa conflitos. A captura guarda apenas o último frame pendente durante o OCR; um watchdog tenta recriar a captura quando um processamento excede dez segundos ou ocorre erro. Atalhos e recuperação ainda precisam de validação interativa. Ao bloquear ou desbloquear a sessão, o monitoramento é parado e deve ser iniciado de novo para estabelecer baseline.

## Executar testes e benchmarks

### Colagem assistida experimental

A versão atual inclui uma ponte local opcional para Chrome ou Edge. No navegador, abra a página de extensões, ative o modo do desenvolvedor e carregue a pasta `browser-extension` como extensão sem compactação. No XboxKeyWatcher, clique em **Colagem assistida** para abrir o pareamento. Copie o código, abra o pop-up da extensão na aba HTTPS que deseja autorizar, cole o código e clique em **Autorizar esta aba**. Em seguida, clique no campo vazio que receberá a key.

Uma nova cópia confirmada pelo monitor fica disponível por até 30 segundos. A extensão preenche apenas a aba autorizada, com o campo escolhido em foco e vazio, depois de verificar que o clipboard ainda contém a mesma key. Se você rolar no WhatsApp, volte ao campo dentro desse prazo. O envio do formulário é manual. **Parar** limpa a key pendente e **Desativar colagem** encerra a ponte. Uma reinicialização do aplicativo requer novo pareamento.

O teste `dotnet run --project benchmarks/CaptureBenchmark -c Release -- --paste-bridge-test` exercita a ponte local. O teste `node benchmarks/browser-paste-prototype.mjs` verifica o preenchimento de um formulário fictício no navegador. O pareamento da extensão com uma aba real ainda requer validação interativa.

Com .NET SDK 8+ e Python 3.13, abra PowerShell neste diretório:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-dev.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\test.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\benchmark.ps1
```

As dependências Python e o compilador Zig ficam em `.venv`; o modelo Tesseract fica em `models`. O último comando gera seis imagens sintéticas fictícias, mede C# com Windows OCR, Python com RapidOCR em duas configurações, Tesseract, comparação de pixels em C/C++/C#/Python e captura + OCR em uma janela sintética. Para também testar o clipboard, depois de desbloquear a sessão gráfica:

```powershell
dotnet run --project benchmarks\CaptureBenchmark -c Release
```

Para exercitar o próprio aplicativo com baseline e duas keys fictícias até o clipboard real, execute `powershell -ExecutionPolicy Bypass -File .\scripts\test.ps1 -WithClipboard` com a sessão desbloqueada. Os testes gráficos padrão incluem baseline, imagem cortada, duas novas keys com destino simulado e uma key que chega durante o baseline. O benchmark tenta preservar o conteúdo anterior do clipboard e só o restaura se o clipboard ainda contiver seu texto fictício. Não execute se outra aplicação estiver usando o clipboard simultaneamente. Resultados estão em `benchmarks\results`; detalhes e limites estão em [docs/medicoes.md](docs/medicoes.md). CPU é calculada em relação a um único núcleo: valores superiores a 100% indicam uso de vários núcleos. Os processos são medidos separadamente, não o uso contínuo do aplicativo.

Para recompilar a distribuição:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build.ps1
```

## Limitações e próximos passos

Falta comprovar o reconhecimento correto de novas imagens reais em posições variadas, a recuperação de falhas, a rolagem, carga prolongada, fontes e imagens reais, múltiplas keys, atalhos, watchdog e logs. Os benchmarks de C, C++ e Python incluem captura, OCR e clipboard numa janela sintética, mas não aplicações completas; usam outra API e outro motor. A medição C# da janela sintética começa na conclusão do desenho do aplicativo de teste e não mede o momento em que a imagem se torna fisicamente visível. Os conjuntos sintéticos são pequenos e não permitem estimar a precisão de produção.
