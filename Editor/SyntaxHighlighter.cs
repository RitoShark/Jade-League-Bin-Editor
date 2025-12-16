using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Windows.Media;

namespace Jade.Editor;

public class SyntaxHighlighter
{
    private static readonly HashSet<string> Keywords = new()
    {
        // Types
        "string", "bool", "u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64",
        "f32", "f64", "vec2", "vec3", "vec4", "list", "map", "option", "link",
        "embed", "hash", "flag", "pointer", "type", "version",
        // Values
        "true", "false", "null",
        // Common property names that should be highlighted
        "entries", "name", "path", "value"
    };

    private static int _callCount = 0;

    public SyntaxType[] AnalyzeLine(string line)
    {
        _callCount++;
        if (_callCount <= 5)
        {
            Services.Logger.Debug($"AnalyzeLine called #{_callCount}: '{line}'");
        }

        if (string.IsNullOrEmpty(line))
            return Array.Empty<SyntaxType>();

        var originalLine = line;
        var types = new SyntaxType[originalLine.Length];
        
        // Initialize all as normal
        for (int i = 0; i < types.Length; i++)
            types[i] = SyntaxType.Normal;

        // Check for comment first (highest priority) - bin files use # for comments
        int commentStart = originalLine.IndexOf("#");
        if (commentStart >= 0)
        {
            for (int i = commentStart; i < types.Length; i++)
                types[i] = SyntaxType.Comment;
        }

        // Mark strings (process full original line)
        bool inString = false;
        int stringStart = -1;
        for (int i = 0; i < originalLine.Length; i++)
        {
            // Skip if already marked as comment
            if (types[i] == SyntaxType.Comment)
                break;
                
            if (originalLine[i] == '"' && (i == 0 || originalLine[i - 1] != '\\'))
            {
                if (!inString)
                {
                    inString = true;
                    stringStart = i;
                }
                else
                {
                    // Mark entire string including quotes
                    for (int j = stringStart; j <= i; j++)
                        types[j] = SyntaxType.String;
                    inString = false;
                }
            }
        }

        // Mark keywords and numbers (only if not in string or comment)
        var words = Regex.Matches(originalLine, @"\b\w+\b");
        foreach (Match match in words)
        {
            bool canHighlight = true;
            for (int i = match.Index; i < match.Index + match.Length && i < types.Length; i++)
            {
                if (types[i] != SyntaxType.Normal)
                {
                    canHighlight = false;
                    break;
                }
            }

            if (canHighlight)
            {
                if (Keywords.Contains(match.Value))
                {
                    for (int i = match.Index; i < match.Index + match.Length && i < types.Length; i++)
                        types[i] = SyntaxType.Keyword;
                }
                else if (Regex.IsMatch(match.Value, @"^\d+\.?\d*$"))
                {
                    for (int i = match.Index; i < match.Index + match.Length && i < types.Length; i++)
                        types[i] = SyntaxType.Number;
                }
            }
        }

        // Debug: Log if we found any highlights
        bool hasHighlights = false;
        for (int i = 0; i < types.Length; i++)
        {
            if (types[i] != SyntaxType.Normal)
            {
                hasHighlights = true;
                break;
            }
        }
        
        if (hasHighlights && originalLine.Length < 100)
        {
            Services.Logger.Debug($"Syntax highlight found in: {originalLine}");
        }

        return types;
    }

    private static readonly Brush KeywordBrush;
    private static readonly Brush StringBrush;
    private static readonly Brush NumberBrush;
    private static readonly Brush CommentBrush;

    static SyntaxHighlighter()
    {
        KeywordBrush = new SolidColorBrush(Color.FromRgb(86, 156, 214));
        KeywordBrush.Freeze();
        
        StringBrush = new SolidColorBrush(Color.FromRgb(206, 145, 120));
        StringBrush.Freeze();
        
        NumberBrush = new SolidColorBrush(Color.FromRgb(181, 206, 168));
        NumberBrush.Freeze();
        
        CommentBrush = new SolidColorBrush(Color.FromRgb(106, 153, 85));
        CommentBrush.Freeze();
    }

    public Brush GetBrushForType(SyntaxType type, Brush defaultBrush)
    {
        return type switch
        {
            SyntaxType.Keyword => KeywordBrush,
            SyntaxType.String => StringBrush,
            SyntaxType.Number => NumberBrush,
            SyntaxType.Comment => CommentBrush,
            _ => defaultBrush
        };
    }
}

public enum SyntaxType
{
    Normal,
    Keyword,
    String,
    Number,
    Comment
}
