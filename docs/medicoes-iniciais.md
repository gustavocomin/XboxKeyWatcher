# Medição inicial isolada — 2026-11-02

Hardware: Ryzen 7 5700X, GeForce RTX 2060, aproximadamente 48 GiB RAM, Windows x64. Windows OCR com idioma pt-BR disponível.

Comando: `dotnet run --project benchmarks/OcrBenchmark -c Release`.

Uma imagem sintética de 1200 × 120 pixels, texto branco sobre preto, 30 leituras após aquecimento: 30/30 textos esperados; média 4,01 ms, p50 3,94 ms, p95 4,14 ms, p99 5,56 ms, mínimo 3,83 ms, máximo 5,56 ms. Medição do OCR em imagem já carregada. Não mede captura, localização, clipboard, CPU, memória, latência ponta a ponta, nem precisão em material real. Uma única imagem não representa diversidade de fontes ou fundos e não estabelece taxa de acerto geral.
