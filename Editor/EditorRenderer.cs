using System;
using System.Windows;
using System.Windows.Media;
using Jade.Core;

namespace Jade.Editor;

/// <summary>
/// Handles rendering of text, caret, and selection
/// </summary>
public class EditorRenderer
{
    private readonly Typeface _typeface;
    private readonly double _fontSize;
    private double _lineHeight;
    private double _charWidth;
    private readonly SyntaxHighlighter _syntaxHighlighter;

    public double LineHeight => _lineHeight;
    public double CharWidth => _charWidth;

    public EditorRenderer(FontFamily fontFamily, double fontSize)
    {
        _typeface = new Typeface(fontFamily, FontStyles.Normal, FontWeights.Normal, FontStretches.Normal);
        _fontSize = fontSize;
        _syntaxHighlighter = new SyntaxHighlighter();
        CalculateMetrics();
    }

    private void CalculateMetrics()
    {
        var formattedText = new FormattedText(
            "M",
            System.Globalization.CultureInfo.CurrentCulture,
            FlowDirection.LeftToRight,
            _typeface,
            _fontSize,
            Brushes.Black,
            VisualTreeHelper.GetDpi(Application.Current.MainWindow).PixelsPerDip);

        _charWidth = formattedText.Width;
        _lineHeight = formattedText.Height;
    }

    private static int _renderCallCount = 0;

    public void RenderText(DrawingContext dc, TextBuffer buffer, int startLine, int endLine, 
        double offsetX, double offsetY, Brush textBrush)
    {
        _renderCallCount++;
        if (_renderCallCount <= 3)
        {
            Services.Logger.Debug($"RenderText called #{_renderCallCount}, lines {startLine}-{endLine}, buffer has {buffer.LineCount} lines");
        }

        for (int i = startLine; i <= endLine && i < buffer.LineCount; i++)
        {
            var line = buffer.GetLine(i);
            if (string.IsNullOrEmpty(line)) continue;

            var y = (i - startLine) * _lineHeight + offsetY;

            try
            {
                // Analyze syntax for this line
                var syntaxTypes = _syntaxHighlighter.AnalyzeLine(line);

                if (syntaxTypes.Length == 0 || syntaxTypes.Length != line.Length)
                {
                    // Fallback to plain rendering if analysis failed
                    var formattedText = new FormattedText(
                        line,
                        System.Globalization.CultureInfo.CurrentCulture,
                        FlowDirection.LeftToRight,
                        _typeface,
                        _fontSize,
                        textBrush,
                        VisualTreeHelper.GetDpi(Application.Current.MainWindow).PixelsPerDip);

                    dc.DrawText(formattedText, new Point(offsetX, y));
                    continue;
                }

                // Group consecutive characters with same syntax type
                double currentX = offsetX;
                int segmentStart = 0;
                SyntaxType currentType = syntaxTypes[0];

                bool hasNonNormal = false;
                for (int check = 0; check < syntaxTypes.Length; check++)
                {
                    if (syntaxTypes[check] != SyntaxType.Normal)
                    {
                        hasNonNormal = true;
                        break;
                    }
                }

                if (hasNonNormal && i == startLine && line.Length < 100)
                {
                    Services.Logger.Debug($"Rendering line with highlights: {line}");
                }

                for (int charIndex = 1; charIndex <= line.Length; charIndex++)
                {
                    bool typeChanged = charIndex == line.Length || syntaxTypes[charIndex] != currentType;

                    if (typeChanged)
                    {
                        // Render the segment
                        var segment = line.Substring(segmentStart, charIndex - segmentStart);
                        var brush = _syntaxHighlighter.GetBrushForType(currentType, textBrush);
                        
                        if (currentType != SyntaxType.Normal && i == startLine)
                        {
                            Services.Logger.Debug($"Rendering '{segment}' as {currentType}");
                        }
                        
                        var formattedText = new FormattedText(
                            segment,
                            System.Globalization.CultureInfo.CurrentCulture,
                            FlowDirection.LeftToRight,
                            _typeface,
                            _fontSize,
                            brush,
                            VisualTreeHelper.GetDpi(Application.Current.MainWindow).PixelsPerDip);

                        dc.DrawText(formattedText, new Point(currentX, y));
                        currentX += formattedText.Width;

                        // Start new segment
                        if (charIndex < line.Length)
                        {
                            segmentStart = charIndex;
                            currentType = syntaxTypes[charIndex];
                        }
                    }
                }
            }
            catch
            {
                // Fallback to plain rendering on any error
                var formattedText = new FormattedText(
                    line,
                    System.Globalization.CultureInfo.CurrentCulture,
                    FlowDirection.LeftToRight,
                    _typeface,
                    _fontSize,
                    textBrush,
                    VisualTreeHelper.GetDpi(Application.Current.MainWindow).PixelsPerDip);

                dc.DrawText(formattedText, new Point(offsetX, y));
            }
        }
    }

    public void RenderSelection(DrawingContext dc, TextSelection selection, TextBuffer buffer,
        int startLine, int endLine, double offsetX, double offsetY, Brush selectionBrush)
    {
        if (!selection.HasSelection) return;

        var selStart = Math.Max(selection.StartLine, startLine);
        var selEnd = Math.Min(selection.EndLine, endLine);

        for (int i = selStart; i <= selEnd && i < buffer.LineCount; i++)
        {
            var line = buffer.GetLine(i);
            var y = (i - startLine) * _lineHeight + offsetY;

            int colStart = (i == selection.StartLine) ? selection.StartColumn : 0;
            int colEnd = (i == selection.EndLine) ? selection.EndColumn : line.Length;

            colStart = Math.Clamp(colStart, 0, line.Length);
            colEnd = Math.Clamp(colEnd, 0, line.Length);

            if (colStart < colEnd)
            {
                var x = offsetX + colStart * _charWidth;
                var width = (colEnd - colStart) * _charWidth;
                dc.DrawRectangle(selectionBrush, null, new Rect(x, y, width, _lineHeight));
            }
        }
    }

    public void RenderCaret(DrawingContext dc, int line, int column, int startLine,
        double offsetX, double offsetY, Brush caretBrush)
    {
        var x = offsetX + column * _charWidth;
        var y = (line - startLine) * _lineHeight + offsetY;
        dc.DrawRectangle(caretBrush, null, new Rect(x, y, 2, _lineHeight));
    }

    public (int line, int column) PixelToPosition(double x, double y, int startLine, 
        double offsetX, double offsetY)
    {
        var line = startLine + (int)((y - offsetY) / _lineHeight);
        var column = (int)Math.Round((x - offsetX) / _charWidth);
        return (Math.Max(0, line), Math.Max(0, column));
    }
}
