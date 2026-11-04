using System.Buffers.Binary;
using System.IO.Pipes;
using System.Text.Json;

const string pipeName = "XboxKeyWatcher.NativePaste.v1";
using var input = Console.OpenStandardInput();
using var output = Console.OpenStandardOutput();
byte[] header = new byte[4];

while (input.Read(header, 0, 1) == 1)
{
    input.ReadExactly(header.AsSpan(1));
    int size = BinaryPrimitives.ReadInt32LittleEndian(header);
    if (size is <= 0 or > 1024) return;
    byte[] request = new byte[size];
    input.ReadExactly(request);
    byte[] response;

    try
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(1));
        using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await pipe.ConnectAsync(timeout.Token);
        await pipe.WriteAsync(request, timeout.Token);
        await pipe.WriteAsync("\n"u8.ToArray(), timeout.Token);
        using var reader = new StreamReader(pipe);
        var line = await reader.ReadLineAsync(timeout.Token) ?? throw new IOException();
        response = System.Text.Encoding.UTF8.GetBytes(line);
    }
    catch (Exception error) when (error is IOException or OperationCanceledException)
    {
        response = JsonSerializer.SerializeToUtf8Bytes(new { offline = true });
    }

    BinaryPrimitives.WriteInt32LittleEndian(header, response.Length);
    output.Write(header);
    output.Write(response);
    output.Flush();
}
