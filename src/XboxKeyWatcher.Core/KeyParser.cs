using System.Text.RegularExpressions;

namespace XboxKeyWatcher.Core;

public static partial class KeyParser
{
    // Exactly five visible groups. Never infer or replace ambiguous characters.
    [GeneratedRegex(@"(?<![A-Z0-9])[A-Z0-9]{5}(?:\s*[-‐‑‒–—−]\s*|\s+)[A-Z0-9]{5}(?:\s*[-‐‑‒–—−]\s*|\s+)[A-Z0-9]{5}(?:\s*[-‐‑‒–—−]\s*|\s+)[A-Z0-9]{5}(?:\s*[-‐‑‒–—−]\s*|\s+)[A-Z0-9]{5}(?![A-Z0-9])", RegexOptions.CultureInvariant)]
    private static partial Regex Pattern();

    [GeneratedRegex(@"(?<![A-Z0-9])[A-Z0-9]{3,12}(?:\s*[-‐‑‒–—−]\s*[A-Z0-9]{3,12}){2,6}(?![A-Z0-9])", RegexOptions.CultureInvariant)]
    private static partial Regex SuspiciousPattern();

    public static bool HasMalformedCandidate(string text) => ExtractMalformedCandidates(text).Any();

    public static IEnumerable<string> ExtractMalformedCandidates(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        foreach (Match match in SuspiciousPattern().Matches(text.ToUpperInvariant()))
        {
            int chars = match.Value.Count(c => c is >= 'A' and <= 'Z' or >= '0' and <= '9');
            if (chars is >= 20 and <= 35 && !Extract(match.Value).Any()) yield return match.Value;
        }
    }

    public static IEnumerable<string> Extract(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        string upper = text.ToUpperInvariant();
        foreach (Match match in Pattern().Matches(upper))
        {
            int before = match.Index - 1, after = match.Index + match.Length;
            while (before >= 0 && char.IsWhiteSpace(upper[before])) before--;
            while (after < upper.Length && char.IsWhiteSpace(upper[after])) after++;
            if (before >= 0 && IsSeparator(upper[before]))
            {
                int adjacent = before - 1; while (adjacent >= 0 && char.IsWhiteSpace(upper[adjacent])) adjacent--;
                if (adjacent >= 0 && char.IsAsciiLetterOrDigit(upper[adjacent])) continue;
            }
            if (after < upper.Length && IsSeparator(upper[after]))
            {
                int adjacent = after + 1; while (adjacent < upper.Length && char.IsWhiteSpace(upper[adjacent])) adjacent++;
                if (adjacent < upper.Length && char.IsAsciiLetterOrDigit(upper[adjacent])) continue;
            }
            var chars = match.Value.Where(c => c is >= 'A' and <= 'Z' or >= '0' and <= '9').ToArray();
            if (chars.Length == 25)
                yield return string.Join('-', Enumerable.Range(0, 5).Select(i => new string(chars, i * 5, 5)));
        }
    }

    private static bool IsSeparator(char value) => value is '-' or '‐' or '‑' or '‒' or '–' or '—' or '−';
}
