using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Media;
using ICSharpCode.AvalonEdit.Document;
using ICSharpCode.AvalonEdit.Rendering;

namespace Jade.Editor;

/// <summary>
/// Renders red squiggly underlines beneath syntax errors in the text
/// </summary>
public class ErrorUnderlineRenderer : IBackgroundRenderer
{
    private readonly TextView _textView;
    private List<SyntaxError> _errors = new();

    public ErrorUnderlineRenderer(TextView textView)
    {
        _textView = textView;
    }

    public KnownLayer Layer => KnownLayer.Selection;

    public void UpdateErrors(List<SyntaxError> errors)
    {
        _errors = errors ?? new List<SyntaxError>();
        _textView.InvalidateLayer(Layer);
    }

    public void Draw(TextView textView, DrawingContext drawingContext)
    {
        if (_errors.Count == 0 || textView.Document == null)
            return;

        foreach (var error in _errors)
        {
            try
            {
                if (error.Line < 1 || error.Line > textView.Document.LineCount)
                    continue;

                var line = textView.Document.GetLineByNumber(error.Line);
                var startOffset = line.Offset + Math.Max(0, error.Column - 1);
                var endOffset = Math.Min(line.EndOffset, startOffset + Math.Max(1, error.Length));

                // Use BackgroundGeometryBuilder to get the geometry for the error span
                var builder = new BackgroundGeometryBuilder
                {
                    AlignToWholePixels = true,
                    CornerRadius = 0
                };

                // Add rectangle for the error span
                foreach (var rect in BackgroundGeometryBuilder.GetRectsForSegment(textView, new TextSegment { StartOffset = startOffset, EndOffset = endOffset }))
                {
                    // Draw wavy underline at the bottom of the rectangle
                    var y = rect.Bottom - 1;
                    DrawWavyLine(drawingContext, new Point(rect.Left, y), new Point(rect.Right, y));
                }
            }
            catch
            {
                // Ignore rendering errors for individual underlines
            }
        }
    }

    private void DrawWavyLine(DrawingContext dc, Point start, Point end)
    {
        const double waveHeight = 1.5;
        const double waveLength = 3.0;

        var pen = new Pen(new SolidColorBrush(Color.FromRgb(255, 0, 0)), 1.0);
        pen.Freeze();

        var geometry = new StreamGeometry();
        using (var context = geometry.Open())
        {
            context.BeginFigure(start, false, false);

            double x = start.X;
            bool up = true;

            while (x < end.X)
            {
                x += waveLength / 2;
                if (x > end.X)
                    x = end.X;

                var y = start.Y + (up ? -waveHeight : waveHeight);
                context.LineTo(new Point(x, y), true, false);
                up = !up;
            }
        }

        geometry.Freeze();
        dc.DrawGeometry(null, pen, geometry);
    }
}
