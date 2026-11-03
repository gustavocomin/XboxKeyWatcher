namespace XboxKeyWatcher.Core;

/// <summary>Requires agreeing model outputs and proximity to a single incomplete OCR candidate.</summary>
public static class TesseractEvidence
{
    public static bool TryResolve(string malformedText, string firstText, string secondText, out string key)
        => TryResolveMany([malformedText], firstText, secondText, out key);

    public static bool TryResolveMany(IEnumerable<string> malformedTexts, string firstText, string secondText, out string key)
    {
        key = "";
        var candidates = malformedTexts.SelectMany(KeyParser.ExtractMalformedCandidates).Distinct(StringComparer.Ordinal).ToArray();
        var first = KeyParser.Extract(firstText).Distinct(StringComparer.Ordinal).ToArray();
        var second = KeyParser.Extract(secondText).Distinct(StringComparer.Ordinal).ToArray();
        if (candidates.Length == 0 || first.Length != 1 || second.Length != 1 || first[0] != second[0]) return false;
        static string Alphanumeric(string value) => new(value.ToUpperInvariant().Where(c => c is >= 'A' and <= 'Z' or >= '0' and <= '9').ToArray());
        string destination = Alphanumeric(first[0]);
        int best = int.MaxValue;
        foreach (var candidate in candidates)
        {
        string source = Alphanumeric(candidate);
        int[] previous = Enumerable.Range(0, destination.Length + 1).ToArray();
        for (int i = 1; i <= source.Length; i++)
        {
            var current = new int[destination.Length + 1]; current[0] = i;
            for (int j = 1; j <= destination.Length; j++)
                current[j] = Math.Min(Math.Min(previous[j]+1, current[j-1]+1), previous[j-1]+(source[i-1] == destination[j-1] ? 0 : 1));
            previous = current;
        }
        int distance = previous[destination.Length];
        if (distance > 4)
        {
            var groups = System.Text.RegularExpressions.Regex.Split(candidate.ToUpperInvariant(), @"\s*[-‐‑‒–—−]\s*");
            var expectedGroups = first[0].Split('-');
            if (groups.Length != 5 || groups.Where((group, i) => Alphanumeric(group) == expectedGroups[i]).Count() < 3) return false;
        }
        best = Math.Min(best, distance);
        }
        if (best > 2) return false;
        key = first[0]; return true;
    }
}
