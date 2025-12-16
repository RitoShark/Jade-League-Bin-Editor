using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using Jade.Core;
using Jade.Services;

namespace Jade.Editor;

/// <summary>
/// Custom WPF text editor control
/// </summary>
public class TextEditorControl : FrameworkElement
{
    private readonly TextBuffer _buffer;
    private readonly TextSelection _selection;
    private readonly InputController _inputController;
    private readonly EditorRenderer _renderer;
    private readonly DispatcherTimer _caretTimer;
    private bool _caretVisible = true;

    private ScrollViewer? _scrollViewer;
    private double _scrollOffsetX;
    private double _scrollOffsetY;

    public TextBuffer Buffer => _buffer;

    public TextEditorControl()
    {
        _buffer = new TextBuffer();
        _selection = new TextSelection();
        _inputController = new InputController(_buffer, _selection);
        _renderer = new EditorRenderer(new FontFamily("Consolas"), 14);

        Focusable = true;

        _buffer.ContentChanged += (s, e) => InvalidateVisual();
        _inputController.CaretMoved += (s, e) => { InvalidateVisual(); ResetCaretBlink(); };
        _inputController.SelectionChanged += (s, e) => InvalidateVisual();

        _caretTimer = new DispatcherTimer
        {
            Interval = TimeSpan.FromMilliseconds(500)
        };
        _caretTimer.Tick += (s, e) =>
        {
            _caretVisible = !_caretVisible;
            InvalidateVisual();
        };
        _caretTimer.Start();
    }

    public void SetScrollViewer(ScrollViewer scrollViewer)
    {
        _scrollViewer = scrollViewer;
        _scrollViewer.ScrollChanged += (s, e) =>
        {
            _scrollOffsetX = e.HorizontalOffset;
            _scrollOffsetY = e.VerticalOffset;
            InvalidateVisual();
        };
    }

    protected override void OnRender(DrawingContext dc)
    {
        try
        {
            base.OnRender(dc);

            // Dark background
            dc.DrawRectangle(new SolidColorBrush(Color.FromRgb(30, 30, 30)), null, 
                new Rect(0, 0, ActualWidth, ActualHeight));

            if (_buffer.LineCount == 0)
            {
                return;
            }

            var startLine = (int)(_scrollOffsetY / _renderer.LineHeight);
            var visibleLines = (int)(ActualHeight / _renderer.LineHeight) + 2;
            var endLine = Math.Min(startLine + visibleLines, _buffer.LineCount - 1);

            var offsetX = 0 - _scrollOffsetX;
            var offsetY = -(_scrollOffsetY % _renderer.LineHeight);

            _selection.Normalize();
            // VSCode-style selection color
            _renderer.RenderSelection(dc, _selection, _buffer, startLine, endLine, 
                offsetX, offsetY, new SolidColorBrush(Color.FromArgb(80, 38, 79, 120)));

            // Light text on dark background
            _renderer.RenderText(dc, _buffer, startLine, endLine, offsetX, offsetY, 
                new SolidColorBrush(Color.FromRgb(212, 212, 212)));

            if (_caretVisible && IsFocused)
            {
                // White caret
                _renderer.RenderCaret(dc, _inputController.CaretLine, _inputController.CaretColumn,
                    startLine, offsetX, offsetY, Brushes.White);
            }
        }
        catch (Exception ex)
        {
            Logger.Error("OnRender failed", ex);
        }
    }

    protected override Size MeasureOverride(Size availableSize)
    {
        var maxLineLength = 0;
        for (int i = 0; i < _buffer.LineCount; i++)
        {
            maxLineLength = Math.Max(maxLineLength, _buffer.GetLine(i).Length);
        }

        var width = maxLineLength * _renderer.CharWidth + 20;
        var height = _buffer.LineCount * _renderer.LineHeight;

        return new Size(width, height);
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        _inputController.HandleKeyDown(e);
        InvalidateMeasure();
    }

    protected override void OnTextInput(TextCompositionEventArgs e)
    {
        base.OnTextInput(e);
        if (!string.IsNullOrEmpty(e.Text) && !char.IsControl(e.Text[0]))
        {
            _inputController.HandleTextInput(e.Text);
            InvalidateMeasure();
        }
    }

    protected override void OnMouseLeftButtonDown(MouseButtonEventArgs e)
    {
        try
        {
            base.OnMouseLeftButtonDown(e);
            Services.Logger.Debug("Mouse left button down");
            Focus();

            var pos = e.GetPosition(this);
            var offsetX = 0 - _scrollOffsetX;
            var offsetY = -(_scrollOffsetY % _renderer.LineHeight);
            var startLine = (int)(_scrollOffsetY / _renderer.LineHeight);

            var (line, column) = _renderer.PixelToPosition(pos.X, pos.Y, startLine, offsetX, offsetY);
            
            Services.Logger.Debug($"Click position: line={line}, col={column}, bufferLines={_buffer.LineCount}");
            
            // Clamp to valid position
            if (_buffer.LineCount == 0)
            {
                Services.Logger.Error("Buffer is empty on mouse click");
                return;
            }
            
            line = Math.Max(0, Math.Min(line, _buffer.LineCount - 1));
            var lineText = _buffer.GetLine(line);
            column = Math.Max(0, Math.Min(column, lineText.Length));
            
            _inputController.SetCaretPosition(line, column, false);

            CaptureMouse();
            e.Handled = true;
        }
        catch (Exception ex)
        {
            Services.Logger.Error("OnMouseLeftButtonDown failed", ex);
        }
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        try
        {
            base.OnMouseMove(e);
            if (e.LeftButton == MouseButtonState.Pressed && IsMouseCaptured)
            {
                if (_buffer.LineCount == 0)
                {
                    return;
                }
                
                var pos = e.GetPosition(this);
                var offsetX = 0 - _scrollOffsetX;
                var offsetY = -(_scrollOffsetY % _renderer.LineHeight);
                var startLine = (int)(_scrollOffsetY / _renderer.LineHeight);

                var (line, column) = _renderer.PixelToPosition(pos.X, pos.Y, startLine, offsetX, offsetY);
                
                // Clamp to valid position
                line = Math.Max(0, Math.Min(line, _buffer.LineCount - 1));
                var lineText = _buffer.GetLine(line);
                column = Math.Max(0, Math.Min(column, lineText.Length));
                
                _inputController.SetCaretPosition(line, column, true);
            }
        }
        catch (Exception ex)
        {
            Services.Logger.Error("OnMouseMove failed", ex);
        }
    }

    protected override void OnMouseLeftButtonUp(MouseButtonEventArgs e)
    {
        base.OnMouseLeftButtonUp(e);
        ReleaseMouseCapture();
    }

    private void ResetCaretBlink()
    {
        _caretVisible = true;
        _caretTimer.Stop();
        _caretTimer.Start();
    }
}
