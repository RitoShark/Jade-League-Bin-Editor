using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Media;
using ICSharpCode.AvalonEdit.Rendering;
using ICSharpCode.AvalonEdit.Document;

namespace Jade.Editor;

public class SearchHighlightRenderer : IBackgroundRenderer
{
    private readonly Brush _markerBrush;
    private Brush _textHighlightBrush;
    private readonly TextView _textView;
    private List<int> _searchOffsets = new List<int>();
    private int _searchLength;
    
    public void SetHighlightColor(Color color)
    {
        _textHighlightBrush = new SolidColorBrush(color);
        _textHighlightBrush.Freeze();
        _textView?.InvalidateLayer(Layer);
    }
    
    public List<int> SearchOffsets
    {
        get => _searchOffsets;
        set
        {
            _searchOffsets = value ?? new List<int>();
            _textView?.InvalidateLayer(Layer);
        }
    }
    
    public int SearchLength
    {
        get => _searchLength;
        set
        {
            if (_searchLength != value)
            {
                _searchLength = value;
                _textView?.InvalidateLayer(Layer);
            }
        }
    }

    public bool HasMarkerNearLine(int lineNumber, int totalLines, double visibleHeight)
    {
        if (_textView?.Document == null) return false;
        
        // Calculate tolerance based on marker height (2 pixels)
        int tolerance = (int)Math.Ceiling(totalLines * 3.0 / Math.Max(100, visibleHeight));
        tolerance = Math.Max(0, tolerance);
        
        foreach (var offset in _searchOffsets)
        {
            if (offset < 0 || offset >= _textView.Document.TextLength) continue;
            var location = _textView.Document.GetLocation(offset);
            if (Math.Abs(location.Line - lineNumber) <= tolerance) return true;
        }
        return false;
    }
    
    public SearchHighlightRenderer(TextView textView)
    {
        _textView = textView;
        // Use a bright orange/gold color for minimap markers
        _markerBrush = new SolidColorBrush(Color.FromArgb(200, 255, 165, 0));
        _markerBrush.Freeze();
        
        // Subtle yellow for text highlighting (matches VS Code style)
        // 50 opacity, 255 R, 215 G, 0 B
        _textHighlightBrush = new SolidColorBrush(Color.FromArgb(50, 255, 215, 0));
        _textHighlightBrush.Freeze();
    }
    
    public KnownLayer Layer => KnownLayer.Background;
    
    public void Draw(TextView textView, DrawingContext drawingContext)
    {
        if (textView?.Document == null || _searchOffsets.Count == 0) return;
        
        try
        {
            var document = textView.Document;
            double totalLines = document.LineCount;
            double viewportHeight = textView.ActualHeight;
            
            // Draw on the right edge, same as bracket scope lines
            double indicatorX = textView.ActualWidth - 15.0; // Same X as bracket renderer
            const double indicatorWidth = 8.0; // Slightly wider than bracket lines
            const double indicatorHeight = 2.0; // Thin lines for search results
            
            foreach (var offset in _searchOffsets)
            {
                if (offset < 0 || offset >= document.TextLength) continue;
                
                // Draw text highlight if we have a length
                if (_searchLength > 0 && offset + _searchLength <= document.TextLength)
                {
                    var rects = BackgroundGeometryBuilder.GetRectsForSegment(textView, new TextSegment { StartOffset = offset, Length = _searchLength });
                    foreach (var rect in rects)
                    {
                        drawingContext.DrawRectangle(_textHighlightBrush, null, rect);
                    }
                }
                
                // Draw minimap marker
                var location = document.GetLocation(offset);
                double lineRatio = (location.Line - 1) / totalLines;
                double y = lineRatio * viewportHeight;
                
                var markerRect = new Rect(indicatorX - 2, y - indicatorHeight / 2, indicatorWidth, indicatorHeight);
                drawingContext.DrawRectangle(_markerBrush, null, markerRect);
            }
        }
        catch
        {
            // Ignore errors during rendering
        }
    }
}
