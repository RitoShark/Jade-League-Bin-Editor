using System.Collections.Generic;
using System.Linq;

namespace Jade.Editor;

public class SyntaxError
{
    public int Line { get; set; }
    public int Column { get; set; }
    public int Length { get; set; }
    public string Message { get; set; } = "";
}

public static class BinSyntaxValidator
{
    public static List<SyntaxError> Validate(string text)
    {
        var errors = new List<SyntaxError>();
        
        if (string.IsNullOrWhiteSpace(text))
        {
            return errors;
        }
        
        // FIRST: Check for unmatched brackets - this is usually the root cause
        var bracketErrors = ValidateBracketBalance(text);
        if (bracketErrors.Count > 0)
        {
            // If brackets are unbalanced, return those errors first
            // They are likely the root cause of all other errors
            return bracketErrors;
        }
        
        try
        {
            // If brackets are balanced, run full parser validation
            var reader = new Ritobin.BinTextReader(text);
            reader.ValidateAll();
            
            foreach (var (message, position) in reader.Errors)
            {
                var (line, column) = reader.GetLineColumn(position);
                int length = CalculateErrorLength(text, position, message);
                
                errors.Add(new SyntaxError
                {
                    Line = line,
                    Column = column,
                    Length = length,
                    Message = message
                });
            }
        }
        catch (System.Exception ex)
        {
            errors.Add(new SyntaxError
            {
                Line = 1,
                Column = 1,
                Length = 1,
                Message = $"Critical parse error: {ex.Message}"
            });
        }
        
        return errors;
    }
    
    /// <summary>
    /// Validates that all brackets { } are properly matched.
    /// This catches the most common cause of cascading errors.
    /// </summary>
    private static List<SyntaxError> ValidateBracketBalance(string text)
    {
        var errors = new List<SyntaxError>();
        var bracketStack = new Stack<(int Position, int Line, int Column)>();
        
        int line = 1;
        int column = 1;
        bool inString = false;
        bool inComment = false;
        char stringChar = '\0';
        bool escape = false;
        
        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            
            // Track line/column
            if (c == '\n')
            {
                line++;
                column = 1;
                inComment = false;
                escape = false;
                continue;
            }
            
            // Handle comments
            if (!inString && c == '#')
            {
                inComment = true;
            }
            
            if (inComment)
            {
                column++;
                continue;
            }
            
            // Handle escape sequences in strings
            if (escape)
            {
                escape = false;
                column++;
                continue;
            }
            
            if (inString && c == '\\')
            {
                escape = true;
                column++;
                continue;
            }
            
            // Handle string boundaries
            if ((c == '"' || c == '\'') && !inString)
            {
                inString = true;
                stringChar = c;
                column++;
                continue;
            }
            
            if (inString && c == stringChar)
            {
                inString = false;
                column++;
                continue;
            }
            
            if (inString)
            {
                column++;
                continue;
            }
            
            // Now we're not in a string or comment - check brackets
            if (c == '{')
            {
                bracketStack.Push((i, line, column));
            }
            else if (c == '}')
            {
                if (bracketStack.Count == 0)
                {
                    // Unmatched closing bracket
                    errors.Add(new SyntaxError
                    {
                        Line = line,
                        Column = column,
                        Length = 1,
                        Message = "Unmatched '}' - no corresponding opening bracket"
                    });
                }
                else
                {
                    bracketStack.Pop();
                }
            }
            
            column++;
        }
        
        // Any remaining opening brackets are unmatched
        while (bracketStack.Count > 0)
        {
            var (pos, bracketLine, bracketColumn) = bracketStack.Pop();
            errors.Add(new SyntaxError
            {
                Line = bracketLine,
                Column = bracketColumn,
                Length = 1,
                Message = "Unmatched '{' - missing closing bracket"
            });
        }
        
        return errors;
    }
    
    private static int CalculateErrorLength(string text, int position, string message)
    {
        int length = 1;
        
        if (position >= text.Length)
            return length;
        
        if (message.Contains("Expected '"))
        {
            return 1;
        }
        
        int end = position;
        while (end < text.Length && IsWordChar(text[end]))
            end++;
        
        if (end == position && position < text.Length)
            end = position + 1;
        
        length = end - position;
        return System.Math.Min(length, 50);
    }
    
    private static bool IsWordChar(char c)
    {
        return char.IsLetterOrDigit(c) || c == '_' || c == '-' || c == '.';
    }
}
