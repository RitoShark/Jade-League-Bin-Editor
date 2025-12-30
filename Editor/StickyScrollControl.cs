using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;
using System.Windows.Documents;
using System.Windows.Data;
using ICSharpCode.AvalonEdit;
using ICSharpCode.AvalonEdit.Document;
using ICSharpCode.AvalonEdit.Editing;
using ICSharpCode.AvalonEdit.Folding;
using ICSharpCode.AvalonEdit.Highlighting;
using ICSharpCode.AvalonEdit.Rendering;
using Jade.Services;

namespace Jade.Editor;

public class StickyScrollControl : Grid
{
    private TextEditor? _editor;
    private readonly StackPanel _mainStack = new();
    private readonly List<int> _stickyLines = new();
    private bool _isUpdating = false;
    private ICSharpCode.AvalonEdit.Folding.FoldingManager? _foldingManager;

    public StickyScrollControl()
    {
        HorizontalAlignment = HorizontalAlignment.Stretch;
        VerticalAlignment = VerticalAlignment.Top;
        Background = Brushes.Transparent;
        IsHitTestVisible = true;
        
        _mainStack.Orientation = Orientation.Vertical;
        Children.Add(_mainStack);
    }

    public void Initialize(TextEditor editor, ICSharpCode.AvalonEdit.Folding.FoldingManager? foldingManager)
    {
        _editor = editor;
        _foldingManager = foldingManager;
        
        _editor.TextArea.TextView.ScrollOffsetChanged += (s, e) => {
             UpdateStickyLines();
             UpdateHorizontalOffset();
        };
        _editor.TextArea.TextView.VisualLinesChanged += (s, e) => {
             UpdateStickyLines();
             UpdateHorizontalOffset();
        };
        _editor.TextChanged += (s, e) => UpdateStickyLines();
        
        UpdateStickyLines();
    }

    private void UpdateHorizontalOffset()
    {
        if (_editor == null) return;
        
        double horizontalOffset = _editor.HorizontalOffset;

        foreach (var child in _mainStack.Children)
        {
            if (child is FrameworkElement headerRow && headerRow.Tag is StickyItemTag tag)
            {
                // Align text horizontally without vertical offsets
                tag.ContentPanel.Margin = new Thickness(-horizontalOffset, 0, 0, 0);
            }
        }
    }

    private class StickyItemTag
    {
        public FrameworkElement ContentPanel { get; set; } = null!;
    }

    public void UpdateStickyLines(bool force = false)
    {
        if (_isUpdating || _editor == null || _editor.Document == null) return;

        bool isEnabled = ThemeHelper.ReadPreference("StickyScroll", "False") == "True";
        if (!isEnabled || _editor.Visibility != Visibility.Visible)
        {
            this.Visibility = Visibility.Collapsed;
            return;
        }

        var textView = _editor.TextArea.TextView;
        if (!textView.IsVisible) return;

        var firstVisibleLine = textView.GetVisualLineFromVisualTop(textView.ScrollOffset.Y);
        if (firstVisibleLine == null) return;

        int lineNum = firstVisibleLine.FirstDocumentLine.LineNumber;
        var parentLines = FindParentLines(lineNum);

        if (parentLines.Count == 0)
        {
            this.Visibility = Visibility.Collapsed;
            _stickyLines.Clear();
            _mainStack.Children.Clear();
            return;
        }

        this.Visibility = Visibility.Visible;
        RenderStickyLines(parentLines, force);
    }

    private List<int> FindParentLines(int currentLine)
    {
        var parents = new List<int>();
        if (_editor == null || _foldingManager == null) return parents;

        int currentOffset = _editor.Document.GetLineByNumber(currentLine).Offset;

        var containingFoldings = _foldingManager.AllFoldings
            .Where(f => f.StartOffset < currentOffset && f.EndOffset > currentOffset)
            .OrderBy(f => f.StartOffset)
            .ToList();

        foreach (var folding in containingFoldings)
        {
            var line = _editor.Document.GetLineByOffset(folding.StartOffset);
            parents.Add(line.LineNumber);
        }

        return parents.Distinct().ToList();
    }

    private void RenderStickyLines(List<int> lines, bool force = false)
    {
        if (!force && lines.SequenceEqual(_stickyLines)) 
        {
            UpdateHorizontalOffset();
            return;
        }

        _isUpdating = true;
        try
        {
            _stickyLines.Clear();
            _stickyLines.AddRange(lines);
            
            _mainStack.Children.Clear();

            var doc = _editor!.Document;
            var lineNumFg = (Brush)_editor.GetValue(ICSharpCode.AvalonEdit.TextEditor.LineNumbersForegroundProperty);
            
            Brush stickyBg = Brushes.Transparent;
            // VISIBILITY: Increase the '40' to make the separator lines darker/more visible
            Brush borderBrush = new SolidColorBrush(Color.FromArgb(80, 128, 128, 128));
            Brush hoverBg = new SolidColorBrush(Color.FromArgb(50, 128, 128, 128));

            try
            {
                var bgBrush = _editor.TryFindResource("EditorBackgroundBrush") as SolidColorBrush;
                if (bgBrush != null)
                    stickyBg = new SolidColorBrush(Color.FromRgb(bgBrush.Color.R, bgBrush.Color.G, bgBrush.Color.B));
                
                var themeBorder = _editor.TryFindResource("SubtleBorderBrush") as SolidColorBrush;
                if (themeBorder != null) borderBrush = themeBorder;
                
                var accent = _editor.TryFindResource("ButtonHoverBrush") as SolidColorBrush;
                if (accent != null) hoverBg = accent;
            }
            catch { }

            if (stickyBg == Brushes.Transparent)
            {
                if (_editor.Background is SolidColorBrush scb)
                    stickyBg = new SolidColorBrush(Color.FromRgb(scb.Color.R, scb.Color.G, scb.Color.B));
                else
                    stickyBg = _editor.Background;
            }

            var margins = _editor.TextArea.LeftMargins;
            var highlighter = _editor.TextArea.GetService(typeof(IHighlighter)) as IHighlighter;

            // Get bracket brushes from resources
            var bracketBrushes = new List<Brush>();
            try
            {
                for (int i = 1; i <= 3; i++)
                {
                    var b = _editor.TryFindResource($"BracketColor{i}") as SolidColorBrush;
                    if (b != null) bracketBrushes.Add(b);
                }
            }
            catch { }
            if (bracketBrushes.Count == 0)
            {
                bracketBrushes.Add(Brushes.Gold);
                bracketBrushes.Add(Brushes.Magenta);
                bracketBrushes.Add(Brushes.Cyan);
            }

            foreach (var lineNum in lines)
            {
                var line = doc.GetLineByNumber(lineNum);
                var lineText = doc.GetText(line);
                
                var rootGrid = new Grid { Background = Brushes.Transparent };
                
                int lineNumColumn = -1;
                int foldingMarginColumn = -1;
                int lastMarginColumn = -1;

                // 1. Margins Area (Line numbers, folding markers, etc.)
                foreach (var margin in margins)
                {
                    if (margin is UIElement mElement && mElement.Visibility == Visibility.Visible)
                    {
                        var col = new ColumnDefinition();
                        col.SetBinding(ColumnDefinition.WidthProperty, new Binding("ActualWidth") { Source = mElement });
                        rootGrid.ColumnDefinitions.Add(col);
                        
                        int colIndex = rootGrid.ColumnDefinitions.Count - 1;
                        lastMarginColumn = colIndex;
                        if (margin is LineNumberMargin) lineNumColumn = colIndex;
                        if (margin is FoldingMargin) foldingMarginColumn = colIndex;
                    }
                }

                // 2. Editor Internal Padding (This comes between margins and text in AvalonEdit)
                rootGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(_editor.Padding.Left) });
                
                rootGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                int contentColumn = rootGrid.ColumnDefinitions.Count - 1;

                // 1. Line Number Area (Native looking)
                if (lineNumColumn != -1)
                {
                    var lineNumText = new TextBlock
                    {
                        Text = lineNum.ToString(),
                        FontFamily = _editor.FontFamily,
                        FontSize = _editor.FontSize,
                        Foreground = lineNumFg,
                        HorizontalAlignment = HorizontalAlignment.Right,
                        VerticalAlignment = VerticalAlignment.Center,
                        // ALIGNMENT: Decrease the '2' to move numbers further right, increase to move left
                        Margin = new Thickness(0, 0, -10, 0), 
                        Padding = new Thickness(0)
                    };
                    Grid.SetColumn(lineNumText, lineNumColumn);
                    rootGrid.Children.Add(lineNumText);
                }
                
                // 2. Vertical Separator (Matching the editor's dotted divider)
                if (lastMarginColumn != -1)
                {
                    var verticalLine = new Line
                    {
                        X1 = 0, Y1 = 0,
                        X2 = 0, Y2 = 1,
                        Stretch = Stretch.Fill,
                        Stroke = borderBrush,
                        StrokeThickness = 1,
                        StrokeDashArray = new DoubleCollection(new double[] { 0.5, 1.5 }),
                        HorizontalAlignment = HorizontalAlignment.Right,
                        VerticalAlignment = VerticalAlignment.Stretch,
                        SnapsToDevicePixels = true,
                        Margin = new Thickness(0, 0, 6, 0)
                    };
                    Grid.SetColumn(verticalLine, lastMarginColumn);
                    rootGrid.Children.Add(verticalLine);
                }

                // 3. Content Area
                var contentGrid = new Grid { ClipToBounds = true, Background = Brushes.Transparent };
                var textPanel = CreateHighlightedTextBlock(lineText, line, highlighter, bracketBrushes);
                textPanel.HorizontalAlignment = HorizontalAlignment.Left;
                textPanel.VerticalAlignment = VerticalAlignment.Center;
                contentGrid.Children.Add(textPanel);
                Grid.SetColumn(contentGrid, contentColumn);
                rootGrid.Children.Add(contentGrid);

                // Use a Border instead of a Button for "raw editor" look
                var rowContainer = new Border
                {
                    Child = rootGrid,
                    Background = stickyBg,
                    Height = _editor.TextArea.TextView.DefaultLineHeight,
                    Cursor = System.Windows.Input.Cursors.Hand,
                    ToolTip = $"Jump to line {lineNum}",
                    Tag = new StickyItemTag { ContentPanel = textPanel }
                };

                rowContainer.MouseEnter += (s, e) => rowContainer.Background = hoverBg;
                rowContainer.MouseLeave += (s, e) => rowContainer.Background = stickyBg;

                int targetLineNum = lineNum;
                rowContainer.MouseLeftButtonDown += (s, e) => 
                {
                    _editor.ScrollToLine(targetLineNum);
                    _editor.CaretOffset = doc.GetLineByNumber(targetLineNum).Offset;
                    _editor.Focus();
                };

                _mainStack.Children.Add(rowContainer);
            }
            
            // Add a single border at the bottom of the whole stack
            var bottomBorder = new Rectangle
            {
                Height = 1,
                Fill = borderBrush,
                VerticalAlignment = VerticalAlignment.Bottom
            };
            _mainStack.Children.Add(bottomBorder);

            UpdateHorizontalOffset();
        }
        finally
        {
            _isUpdating = false;
        }
    }

    private TextBlock CreateHighlightedTextBlock(string text, IDocumentLine line, IHighlighter? highlighter, List<Brush> bracketBrushes)
    {
        var textBlock = new TextBlock
        {
            FontFamily = _editor!.FontFamily,
            FontSize = _editor.FontSize,
            VerticalAlignment = VerticalAlignment.Center,
            Foreground = _editor.Foreground,
            TextWrapping = TextWrapping.NoWrap
        };

        if (highlighter == null)
        {
            textBlock.Text = text.TrimEnd();
            return textBlock;
        }

        try
        {
            var highlightedLine = highlighter.HighlightLine(line.LineNumber);
            int lastOffset = line.Offset;
            string originalText = text;
            int bracketDepth = GetBracketDepthAtStartOfLine(line.LineNumber);

            foreach (var section in highlightedLine.Sections)
            {
                if (section.Offset > lastOffset)
                {
                    int startIdx = lastOffset - line.Offset;
                    int length = section.Offset - lastOffset;
                    if (startIdx >= 0 && startIdx < originalText.Length)
                    {
                        length = Math.Min(length, originalText.Length - startIdx);
                        string sectionText = originalText.Substring(startIdx, length);
                        AddTextWithBrackets(textBlock, sectionText, textBlock.Foreground, bracketBrushes, ref bracketDepth);
                    }
                }
                
                int start = Math.Max(0, section.Offset - line.Offset);
                int sectionLength = Math.Min(section.Length, originalText.Length - start);
                if (sectionLength > 0)
                {
                    string sectionText = originalText.Substring(start, sectionLength);
                    Brush foreground = textBlock.Foreground;
                    FontWeight? weight = null;
                    FontStyle? style = null;

                    if (section.Color != null)
                    {
                        var brush = section.Color.Foreground?.GetBrush(null);
                        if (brush != null) foreground = brush;
                        if (section.Color.FontWeight != null) weight = section.Color.FontWeight.Value;
                        if (section.Color.FontStyle != null) style = section.Color.FontStyle.Value;
                    }
                    
                    AddTextWithBrackets(textBlock, sectionText, foreground, bracketBrushes, ref bracketDepth, weight, style);
                }
                lastOffset = section.Offset + section.Length;
            }
            
            if (lastOffset < line.Offset + originalText.Length)
            {
                int startIdx = lastOffset - line.Offset;
                if (startIdx >= 0 && startIdx < originalText.Length)
                {
                    string sectionText = originalText.Substring(startIdx).TrimEnd();
                    AddTextWithBrackets(textBlock, sectionText, textBlock.Foreground, bracketBrushes, ref bracketDepth);
                }
            }
        }
        catch { textBlock.Text = text.TrimEnd(); }

        return textBlock;
    }

    private int GetBracketDepthAtStartOfLine(int lineNum)
    {
        if (_editor == null || _editor.Document == null) return 0;
        int depth = 0;
        try
        {
            int offset = _editor.Document.GetLineByNumber(lineNum).Offset;
            string text = _editor.Document.GetText(0, offset);
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (c == '{' || c == '[' || c == '(') depth++;
                else if (c == '}' || c == ']' || c == ')') depth = Math.Max(0, depth - 1);
            }
        }
        catch { }
        return depth;
    }

    private void AddTextWithBrackets(TextBlock textBlock, string text, Brush defaultBrush, List<Brush> bracketBrushes, ref int depth, FontWeight? weight = null, FontStyle? style = null)
    {
        int start = 0;
        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            bool isOpening = (c == '{' || c == '[' || c == '(');
            bool isClosing = (c == '}' || c == ']' || c == ')');
            
            if (isOpening || isClosing)
            {
                // Add previous segment
                if (i > start)
                {
                    var run = new Run(text.Substring(start, i - start)) { Foreground = defaultBrush };
                    if (weight.HasValue) run.FontWeight = weight.Value;
                    if (style.HasValue) run.FontStyle = style.Value;
                    textBlock.Inlines.Add(run);
                }
                
                // Add bracket
                int colorIndex;
                if (isOpening)
                {
                    colorIndex = depth % bracketBrushes.Count;
                    depth++;
                }
                else
                {
                    depth = Math.Max(0, depth - 1);
                    colorIndex = depth % bracketBrushes.Count;
                }
                
                var bracketRun = new Run(c.ToString()) { Foreground = bracketBrushes[colorIndex] };
                if (weight.HasValue) bracketRun.FontWeight = weight.Value;
                if (style.HasValue) bracketRun.FontStyle = style.Value;
                textBlock.Inlines.Add(bracketRun);
                
                start = i + 1;
            }
        }
        
        // Add remaining segment
        if (start < text.Length)
        {
            var run = new Run(text.Substring(start)) { Foreground = defaultBrush };
            if (weight.HasValue) run.FontWeight = weight.Value;
            if (style.HasValue) run.FontStyle = style.Value;
            textBlock.Inlines.Add(run);
        }
    }
}
