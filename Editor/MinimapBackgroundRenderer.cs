using System.Windows;
using System.Windows.Media;
using ICSharpCode.AvalonEdit.Rendering;

namespace Jade.Editor;

/// <summary>
/// Renders a subtle background for the minimap area on the right edge
/// </summary>
public class MinimapBackgroundRenderer : IBackgroundRenderer
{
    private readonly TextView _textView;
    private Color _backgroundColor = Color.FromArgb(40, 255, 255, 255); // Subtle light tint
    
    public const double MinimapWidth = 20.0;

    public MinimapBackgroundRenderer(TextView textView)
    {
        _textView = textView;
    }

    public KnownLayer Layer => KnownLayer.Background;
    
    public void SetBackgroundColor(Color color)
    {
        _backgroundColor = color;
        _textView.InvalidateLayer(Layer);
    }

    public void Draw(TextView textView, DrawingContext drawingContext)
    {
        if (textView.Document == null)
            return;

        var renderSize = textView.RenderSize;
        
        // Draw subtle background on the right edge
        var backgroundRect = new Rect(
            renderSize.Width - MinimapWidth, 
            0, 
            MinimapWidth, 
            renderSize.Height);
        
        drawingContext.DrawRectangle(
            new SolidColorBrush(_backgroundColor),
            null,
            backgroundRect);
    }
}
