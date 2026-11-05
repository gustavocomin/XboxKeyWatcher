using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace XboxKeyWatcher.App;

/// <summary>
/// Key times (poll-rapido.txt: "10:00" every day or "2026-11-06 10:00") and how far around
/// each one the app gets ready (agenda.json): the bots connect BotMinutesBefore ahead, the
/// fast channel poll and the screen reading run from PollMinutesBefore ahead until
/// MinutesAfter. Both files sit in tools/wa-listener, where the bot reads them too.
/// </summary>
internal sealed class KeySchedule
{
    public const string TimesFile = "poll-rapido.txt", AgendaFile = "agenda.json";
    private static readonly Regex TimeLine = new(@"^(?:(\d{4})-(\d{2})-(\d{2})\s+)?(\d{1,2}):(\d{2})$");

    public sealed record Agenda(int BotMinutesBefore = 5, int PollMinutesBefore = 2, int MinutesAfter = 10);

    public Agenda Times { get; private init; } = new();
    public List<(DateTime? Date, TimeSpan Time)> Entries { get; private init; } = [];
    public bool HasTimes => Entries.Count > 0;

    public static KeySchedule Load(string? dir)
    {
        if (dir is null) return new KeySchedule();
        return new KeySchedule { Times = LoadAgenda(dir), Entries = Parse(ReadText(Path.Combine(dir, TimesFile))) };
    }

    public static Agenda LoadAgenda(string dir)
    {
        try
        {
            var a = JsonSerializer.Deserialize<Agenda>(File.ReadAllText(Path.Combine(dir, AgendaFile))) ?? new Agenda();
            return new Agenda(Math.Clamp(a.BotMinutesBefore, 1, 60), Math.Clamp(a.PollMinutesBefore, 0, 30), Math.Clamp(a.MinutesAfter, 1, 60));
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException) { return new Agenda(); }
    }

    private static string ReadText(string path) { try { return File.ReadAllText(path); } catch (IOException) { return ""; } }

    internal static List<(DateTime? Date, TimeSpan Time)> Parse(string text)
    {
        var list = new List<(DateTime?, TimeSpan)>();
        foreach (var raw in text.Replace("\r\n", "\n").Split('\n'))
        {
            var m = TimeLine.Match(Regex.Replace(raw, "#.*$", "").Trim());
            if (!m.Success) continue;
            int h = int.Parse(m.Groups[4].Value), min = int.Parse(m.Groups[5].Value);
            if (h > 23 || min > 59) continue;
            DateTime? date = null;
            if (m.Groups[1].Success)
            {
                if (!DateTime.TryParseExact($"{m.Groups[1].Value}-{m.Groups[2].Value}-{m.Groups[3].Value}", "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d)) continue;
                date = d;
            }
            list.Add((date, new TimeSpan(h, min, 0)));
        }
        return list;
    }

    /// <summary>Key moments near now (yesterday, today and tomorrow for daily times).</summary>
    private IEnumerable<DateTime> Moments(DateTime now)
    {
        foreach (var (date, time) in Entries)
            if (date is { } d) yield return d.Date + time;
            else for (int day = -1; day <= 1; day++) yield return now.Date.AddDays(day) + time;
    }

    public bool InBotWindow(DateTime now) => Moments(now).Any(t => now >= t.AddMinutes(-Times.BotMinutesBefore) && now <= t.AddMinutes(Times.MinutesAfter));
    public bool InPollWindow(DateTime now) => Moments(now).Any(t => now >= t.AddMinutes(-Times.PollMinutesBefore) && now <= t.AddMinutes(Times.MinutesAfter));

    /// <summary>Next key moment after now (for the status line), or null.</summary>
    public DateTime? Next(DateTime now) => Moments(now).Where(t => t.AddMinutes(Times.MinutesAfter) >= now).OrderBy(t => t).Cast<DateTime?>().FirstOrDefault();

    /// <summary>Text without dated lines whose window ended more than a day ago; null if nothing to drop.</summary>
    internal static string? DropExpired(string text, Agenda agenda, DateTime now)
    {
        var lines = text.Replace("\r\n", "\n").Split('\n').ToList();
        bool changed = false;
        for (int i = lines.Count - 1; i >= 0; i--)
        {
            var entry = Parse(lines[i]);
            if (entry.Count == 1 && entry[0].Date is { } d && d.Date + entry[0].Time + TimeSpan.FromMinutes(agenda.MinutesAfter) < now.AddDays(-1))
            { lines.RemoveAt(i); changed = true; }
        }
        return changed ? string.Join("\n", lines) : null;
    }
}
