using System;
using System.Windows;
using System.Windows.Media;
using ICSharpCode.AvalonEdit.Rendering;

namespace Jade.Editor;

public class BracketScopeLineRenderer : IBackgroundRenderer
{
    private readonly Brush _markerBrush;
    private readonly TextView _textView;
    
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
                _textView?.InvalidateLayer(Layer);
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
                _textView?.InvalidateLayer(Layer);
            }
        }
    }
    
    public BracketScopeLineRenderer(TextView textView, string theme)
    {
        _textView = textView;
        var markerColor = GetMarkerColorForTheme(theme);
        _markerBrush = new SolidColorBrush(markerColor);
        _markerBrush.Freeze();
    }
    
    private Color GetMarkerColorForTheme(string theme)
    {
        return theme switch
        {
            "DarkBlue" => Color.FromArgb(100, 100, 150, 200),
            "DarkRed" => Color.FromArgb(100, 200, 100, 120),
            "LightPink" => Color.FromArgb(120, 80, 40, 100),
            "PastelBlue" => Color.FromArgb(120, 60, 100, 140),
            "ForestGreen" => Color.FromArgb(100, 120, 200, 150),
            "AMOLED" => Color.FromArgb(120, 200, 200, 200),
            "Void" => Color.FromArgb(100, 150, 120, 200),
            "VioletSorrow" => Color.FromArgb(100, 147, 112, 219),
            _ => Color.FromArgb(100, 150, 150, 150)
        };
    }
    
    public KnownLayer Layer => KnownLayer.Background;
    
    public void Draw(TextView textView, DrawingContext drawingContext)
    {
        if (textView?.Document == null) return;
        
        // Only draw if we have matched brackets on different lines
        if (!OpeningBracketOffset.HasValue || !ClosingBracketOffset.HasValue)
            return;
        
        try
        {
            var document = textView.Document;
            
            var openLocation = document.GetLocation(OpeningBracketOffset.Value);
            var closeLocation = document.GetLocation(ClosingBracketOffset.Value);
            
            // Only draw if brackets are on different lines
            if (openLocation.Line >= closeLocation.Line)
                return;
            
            // Get viewport line range to check visibility
            int firstVisibleLine = textView.VisualLines.Count > 0 ? textView.VisualLines[0].FirstDocumentLine.LineNumber : 1;
            int lastVisibleLine = textView.VisualLines.Count > 0 ? textView.VisualLines[textView.VisualLines.Count - 1].LastDocumentLine.LineNumber : 1;
            
            bool openingVisible = openLocation.Line >= firstVisibleLine && openLocation.Line <= lastVisibleLine;
            bool closingVisible = closeLocation.Line >= firstVisibleLine && closeLocation.Line <= lastVisibleLine;
            
            // Draw fixed minimap-style indicators on the right edge
            double totalLines = document.LineCount;
            double openingRatio = (openLocation.Line - 1) / totalLines;
            double closingRatio = (closeLocation.Line - 1) / totalLines;
            
            double viewportHeight = textView.ActualHeight;
            double indicatorX = textView.ActualWidth - 15.0;
            const double indicatorWidth = 3.0;
            const double indicatorHeight = 15.0;
            
            // Draw opening bracket indicator
            double openingY = openingRatio * viewportHeight;
            var openRect = new Rect(indicatorX, openingY - indicatorHeight / 2, indicatorWidth, indicatorHeight);
            drawingContext.DrawRectangle(_markerBrush, null, openRect);
            
            // Draw closing bracket indicator
            double closingY = closingRatio * viewportHeight;
            var closeRect = new Rect(indicatorX, closingY - indicatorHeight / 2, indicatorWidth, indicatorHeight);
            drawingContext.DrawRectangle(_markerBrush, null, closeRect);
            
            // Draw connecting line between indicators
            var pen = new Pen(_markerBrush, 1.0);
            pen.Freeze();
            drawingContext.DrawLine(pen, new Point(indicatorX + indicatorWidth / 2, openingY), new Point(indicatorX + indicatorWidth / 2, closingY));
            
            // Draw arrows at screen edges when brackets are off-screen
            const double arrowX = 8.0;
            const double arrowSize = 8.0;
            
            if (!openingVisible && openLocation.Line < firstVisibleLine)
            {
                // Opening bracket is above - draw up arrow at top
                double topY = 5.0;
                var points = new Point[]
                {
                    new Point(arrowX, topY),
                    new Point(arrowX - arrowSize / 2, topY + arrowSize),
                    new Point(arrowX + arrowSize / 2, topY + arrowSize)
                };
                var geometry = new StreamGeometry();
                using (var ctx = geometry.Open())
                {
                    ctx.BeginFigure(points[0], true, true);
                    ctx.LineTo(points[1], true, false);
                    ctx.LineTo(points[2], true, false);
                }
                geometry.Freeze();
                drawingContext.DrawGeometry(_markerBrush, null, geometry);
            }
            
            if (!closingVisible && closeLocation.Line > lastVisibleLine)
            {
                // Closing bracket is below - draw down arrow at bottom
                double bottomY = textView.ActualHeight - 15.0;
                var points = new Point[]
                {
                    new Point(arrowX, bottomY + arrowSize),
                    new Point(arrowX - arrowSize / 2, bottomY),
                    new Point(arrowX + arrowSize / 2, bottomY)
                };
                var geometry = new StreamGeometry();
                using (var ctx = geometry.Open())
                {
                    ctx.BeginFigure(points[0], true, true);
                    ctx.LineTo(points[1], true, false);
                    ctx.LineTo(points[2], true, false);
                }
                geometry.Freeze();
                drawingContext.DrawGeometry(_markerBrush, null, geometry);
            }
        }
        catch
        {
            // Silently ignore rendering errors
        }
    }
}
