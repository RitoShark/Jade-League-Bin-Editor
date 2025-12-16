using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Media;
using ICSharpCode.AvalonEdit.Rendering;

namespace Jade.Editor;

/// <summary>
/// Renders red markers on the minimap (right margin) for lines with syntax errors
/// </summary>
public class ErrorHighlightRenderer : IBackgroundRenderer
{
    private readonly TextView _textView;
    private List<SyntaxError> _errors = new();

    public ErrorHighlightRenderer(TextView textView)
    {
        _textView = textView;
    }

    public KnownLayer Layer => KnownLayer.Background;

    public void UpdateErrors(List<SyntaxError> errors)
    {
        _errors = errors ?? new List<SyntaxError>();
        _textView.InvalidateLayer(Layer);
    }

    public string? GetErrorNearLine(int lineNumber, int totalLines, double visibleHeight)
    {
        if (_errors.Count == 0) return null;
        
        // Calculate tolerance based on marker height (3 pixels) relative to total height
        // This ensures hovering anywhere over the visual marker triggers the tooltip
        int tolerance = (int)Math.Ceiling(totalLines * 4.0 / Math.Max(100, visibleHeight));
        tolerance = Math.Max(0, tolerance); // Ensure at least exact match
        
        return _errors.FirstOrDefault(e => Math.Abs(e.Line - lineNumber) <= tolerance)?.Message;
    }

    public void Draw(TextView textView, DrawingContext drawingContext)
    {
        if (_errors.Count == 0 || textView.Document == null)
            return;

        // Get the visible area
        var renderSize = textView.RenderSize;
        var totalLines = textView.Document.LineCount;

        // Draw red markers on the right edge (minimap style)
        var markerWidth = 4.0;
        var markerX = renderSize.Width - markerWidth - 2;

        foreach (var error in _errors)
        {
            try
            {
                if (error.Line < 1 || error.Line > totalLines)
                    continue;

                // Calculate Y position based on line number
                var lineRatio = (double)(error.Line - 1) / Math.Max(1, totalLines - 1);
                var y = lineRatio * renderSize.Height;

                // Draw red rectangle
                var rect = new Rect(markerX, y, markerWidth, 3);
                drawingContext.DrawRectangle(
                    new SolidColorBrush(Color.FromRgb(255, 0, 0)),
                    null,
                    rect);
            }
            catch
            {
                // Ignore rendering errors for individual markers
            }
        }
    }
}
