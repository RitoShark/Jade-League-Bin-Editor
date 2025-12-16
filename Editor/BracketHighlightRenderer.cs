using System;
using System.Windows;
using System.Windows.Media;
using ICSharpCode.AvalonEdit.Document;
using ICSharpCode.AvalonEdit.Rendering;

namespace Jade.Editor;

public class BracketHighlightRenderer : IBackgroundRenderer
{
    private TextView _textView;
    private Pen _borderPen;
    private Brush _backgroundBrush;
    
    private int? _openingBracketOffset;
    private int? _closingBracketOffset;
    
    public int? OpeningBracketOffset 
    { 
        get => _openingBracketOffset;
        set 
        { 
            if (_openingBracketOffset != value)
            {
                _openingBracketOffset = value;
                _textView.InvalidateLayer(Layer);
            }
        }
    }
    
    public int? ClosingBracketOffset 
    { 
        get => _closingBracketOffset;
        set 
        { 
            if (_closingBracketOffset != value)
            {
                _closingBracketOffset = value;
                _textView.InvalidateLayer(Layer);
            }
        }
    }
    
    public BracketHighlightRenderer(TextView textView, string theme)
    {
        _textView = textView;
        
        // Create theme-appropriate highlight colors
        var (bgColor, borderColor) = GetHighlightColorsForTheme(theme);
        
        _backgroundBrush = new SolidColorBrush(bgColor);
        _backgroundBrush.Freeze();
        
        _borderPen = new Pen(new SolidColorBrush(borderColor), 1.5);
        _borderPen.Freeze();
    }
    
    private (Color background, Color border) GetHighlightColorsForTheme(string theme)
    {
        return theme switch
        {
            "DarkBlue" => (Color.FromArgb(50, 100, 150, 200), Color.FromArgb(150, 100, 150, 200)),
            "DarkRed" => (Color.FromArgb(50, 200, 100, 120), Color.FromArgb(150, 200, 100, 120)),
            "LightPink" => (Color.FromArgb(50, 80, 40, 100), Color.FromArgb(180, 80, 40, 100)),
            "PastelBlue" => (Color.FromArgb(50, 60, 100, 140), Color.FromArgb(180, 60, 100, 140)),
            "ForestGreen" => (Color.FromArgb(50, 120, 200, 150), Color.FromArgb(150, 120, 200, 150)),
            "AMOLED" => (Color.FromArgb(60, 200, 200, 200), Color.FromArgb(180, 200, 200, 200)),
            "Void" => (Color.FromArgb(50, 150, 120, 200), Color.FromArgb(150, 150, 120, 200)),
            "VioletSorrow" => (Color.FromArgb(50, 147, 112, 219), Color.FromArgb(150, 147, 112, 219)),
            _ => (Color.FromArgb(50, 150, 150, 150), Color.FromArgb(150, 150, 150, 150)) // Default
        };
    }
    
    public KnownLayer Layer => KnownLayer.Selection;
    
    public void Draw(TextView textView, DrawingContext drawingContext)
    {
        if (OpeningBracketOffset.HasValue)
        {
            DrawBracketHighlight(textView, drawingContext, OpeningBracketOffset.Value);
        }
        
        if (ClosingBracketOffset.HasValue)
        {
            DrawBracketHighlight(textView, drawingContext, ClosingBracketOffset.Value);
        }
    }
    
    private void DrawBracketHighlight(TextView textView, DrawingContext drawingContext, int offset)
    {
        try
        {
            var document = textView.Document;
            if (document == null || offset < 0 || offset >= document.TextLength)
                return;
            
            var location = document.GetLocation(offset);
            var visualLine = textView.GetVisualLine(location.Line);
            
            // If the line is not currently visible, we can't draw it
            // AvalonEdit will call Draw() again when scrolling brings it into view
            if (visualLine == null)
                return;
            
            var builder = new BackgroundGeometryBuilder
            {
                AlignToWholePixels = true,
                CornerRadius = 2
            };
            
            builder.AddSegment(textView, new TextSegment { StartOffset = offset, Length = 1 });
            
            var geometry = builder.CreateGeometry();
            if (geometry != null)
            {
                drawingContext.DrawGeometry(_backgroundBrush, _borderPen, geometry);
            }
        }
        catch
        {
            // Silently ignore errors during rendering
        }
    }
}

public static class BracketMatcher
{
    public static (int? opening, int? closing) FindMatchingBracket(TextDocument document, int caretOffset)
    {
        if (caretOffset < 0 || caretOffset > document.TextLength)
            return (null, null);
        
        // Check character before caret (cursor is after a bracket)
        char? charBeforeCaret = caretOffset > 0 ? document.GetCharAt(caretOffset - 1) : null;
        
        // If caret is after a closing bracket, find its opening bracket
        if (charBeforeCaret.HasValue && IsClosingBracket(charBeforeCaret.Value))
        {
            int? opening = FindOpeningBracket(document, caretOffset - 1, charBeforeCaret.Value);
            if (opening.HasValue)
                return (opening.Value, caretOffset - 1);
        }
        
        // If caret is after an opening bracket, find its closing bracket
        if (charBeforeCaret.HasValue && IsOpeningBracket(charBeforeCaret.Value))
        {
            int? closing = FindClosingBracket(document, caretOffset - 1, charBeforeCaret.Value);
            if (closing.HasValue)
                return (caretOffset - 1, closing.Value);
        }
        
        return (null, null);
    }
    
    private static bool IsOpeningBracket(char c) => c == '{' || c == '[' || c == '(';
    private static bool IsClosingBracket(char c) => c == '}' || c == ']' || c == ')';
    
    private static char GetMatchingClosingBracket(char opening)
    {
        return opening switch
        {
            '{' => '}',
            '[' => ']',
            '(' => ')',
            _ => '\0'
        };
    }
    
    private static char GetMatchingOpeningBracket(char closing)
    {
        return closing switch
        {
            '}' => '{',
            ']' => '[',
            ')' => '(',
            _ => '\0'
        };
    }
    
    private static int? FindClosingBracket(TextDocument document, int startOffset, char openingBracket)
    {
        char closingBracket = GetMatchingClosingBracket(openingBracket);
        if (closingBracket == '\0') return null;
        
        int depth = 1;
        
        for (int i = startOffset + 1; i < document.TextLength; i++)
        {
            char c = document.GetCharAt(i);
            
            if (c == openingBracket)
            {
                depth++;
            }
            else if (c == closingBracket)
            {
                depth--;
                if (depth == 0)
                {
                    return i;
                }
            }
        }
        
        return null;
    }
    
    private static int? FindOpeningBracket(TextDocument document, int startOffset, char closingBracket)
    {
        char openingBracket = GetMatchingOpeningBracket(closingBracket);
        if (openingBracket == '\0') return null;
        
        int depth = 1;
        
        for (int i = startOffset - 1; i >= 0; i--)
        {
            char c = document.GetCharAt(i);
            
            if (c == closingBracket)
            {
                depth++;
            }
            else if (c == openingBracket)
            {
                depth--;
                if (depth == 0)
                {
                    return i;
                }
            }
        }
        
        return null;
    }
}
