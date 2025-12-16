using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using ICSharpCode.AvalonEdit;
using ICSharpCode.AvalonEdit.Document;
using ICSharpCode.AvalonEdit.Rendering;
using Jade.Services;

namespace Jade.Windows;

public class DiffLine
{
    public int LeftLineNumber { get; set; }
    public int RightLineNumber { get; set; }
    public DiffType Type { get; set; }
}

public enum DiffType
{
    Unchanged,
    Added,
    Deleted,
    Modified
}

public class DiffHighlighter : DocumentColorizingTransformer
{
    private readonly List<DiffLine> _diffs;
    private readonly bool _isLeft;
    
    public DiffHighlighter(List<DiffLine> diffs, bool isLeft)
    {
        _diffs = diffs;
        _isLeft = isLeft;
    }
    
    protected override void ColorizeLine(DocumentLine line)
    {
        var lineNumber = line.LineNumber;
        var diff = _diffs.FirstOrDefault(d => 
            _isLeft ? d.LeftLineNumber == lineNumber : d.RightLineNumber == lineNumber);
        
        if (diff != null)
        {
            Color bgColor = Colors.Transparent;
            
            // VS Code style: Red for deletions/changes, Green for additions
            if (_isLeft)
            {
                // Left side: show deletions and modifications in red
                bgColor = diff.Type switch
                {
                    DiffType.Deleted => Color.FromArgb(80, 255, 0, 0),   // Red for deleted
                    DiffType.Modified => Color.FromArgb(80, 255, 0, 0),  // Red for modified
                    _ => Colors.Transparent
                };
            }
            else
            {
                // Right side: show additions and modifications in green
                bgColor = diff.Type switch
                {
                    DiffType.Added => Color.FromArgb(80, 0, 255, 0),     // Green for added
                    DiffType.Modified => Color.FromArgb(80, 0, 255, 0),  // Green for modified
                    _ => Colors.Transparent
                };
            }
            
            if (bgColor != Colors.Transparent)
            {
                ChangeLinePart(line.Offset, line.EndOffset, element =>
                {
                    element.TextRunProperties.SetBackgroundBrush(new SolidColorBrush(bgColor));
                });
            }
        }
    }
}

public partial class CompareDialog : Window
{
    private readonly List<EditorTab> _tabs;
    private List<DiffLine> _differences = new();
    private int _currentDiffIndex = -1;
    
    public CompareDialog(List<EditorTab> tabs)
    {
        InitializeComponent();
        _tabs = tabs;
        
        SourceInitialized += OnSourceInitialized;
        StateChanged += OnWindowStateChanged;
        Closed += OnWindowClosed;
        
        Loaded += (s, e) =>
        {
            // Apply margin on load if maximized
            if (WindowState == WindowState.Maximized)
            {
                RootGrid.Margin = new Thickness(0, 0, 0, 1);
            }
        };
        
        LoadAndApplyTheme();
        PopulateFileComboBoxes();
        
        // Add Shift+Scroll support
        LeftEditor.PreviewMouseWheel += OnEditorMouseWheel;
        RightEditor.PreviewMouseWheel += OnEditorMouseWheel;
    }
    
    private void OnEditorMouseWheel(object sender, MouseWheelEventArgs e)
    {
        if (Keyboard.Modifiers.HasFlag(ModifierKeys.Shift))
        {
            var editor = sender as TextEditor;
            var scrollViewer = editor?.GetScrollViewer();
            
            if (scrollViewer != null)
            {
                if (e.Delta > 0)
                    scrollViewer.LineLeft();
                else
                    scrollViewer.LineRight();
                    
                e.Handled = true;
            }
        }
    }
    
    private void OnWindowClosed(object? sender, EventArgs e)
    {
        try
        {
            // Clear editor content to release memory
            LeftEditor.Text = string.Empty;
            RightEditor.Text = string.Empty;
            
            // Clear transformers
            LeftEditor.TextArea.TextView.LineTransformers.Clear();
            RightEditor.TextArea.TextView.LineTransformers.Clear();
            
            // Clear document
            LeftEditor.Document = null;
            RightEditor.Document = null;
            
            // Clear differences list
            _differences.Clear();
            _differences = null!;
            
            // Clear ComboBox itemsources to prevent memory leaks
            LeftFileComboBox.ItemsSource = null;
            RightFileComboBox.ItemsSource = null;
            
            Logger.Info("Compare dialog closed and resources cleaned up");
            
            // Force garbage collection
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
        }
        catch (Exception ex)
        {
            Logger.Error("Error during compare dialog cleanup", ex);
        }
    }
    
    private void PopulateFileComboBoxes()
    {
        var fileNames = _tabs.Select((tab, index) => new
        {
            Index = index,
            Name = tab.FilePath != null ? Path.GetFileName(tab.FilePath) : $"Untitled {index + 1}"
        }).ToList();
        
        LeftFileComboBox.ItemsSource = fileNames;
        LeftFileComboBox.DisplayMemberPath = "Name";
        LeftFileComboBox.SelectedValuePath = "Index";
        
        RightFileComboBox.ItemsSource = fileNames;
        RightFileComboBox.DisplayMemberPath = "Name";
        RightFileComboBox.SelectedValuePath = "Index";
        
        if (fileNames.Count > 0)
            LeftFileComboBox.SelectedIndex = 0;
        if (fileNames.Count > 1)
            RightFileComboBox.SelectedIndex = 1;
    }
    
    private void OnFileSelectionChanged(object sender, System.Windows.Controls.SelectionChangedEventArgs e)
    {
        if (LeftFileComboBox.SelectedIndex >= 0 && RightFileComboBox.SelectedIndex >= 0)
        {
            CompareFiles();
        }
    }
    
    private void CompareFiles()
    {
        try
        {
            var leftIndex = LeftFileComboBox.SelectedIndex;
            var rightIndex = RightFileComboBox.SelectedIndex;
            
            // Safety check to prevent crash with invalid indices
            if (leftIndex < 0 || rightIndex < 0)
                return;
            
            if (_tabs == null || leftIndex >= _tabs.Count || rightIndex >= _tabs.Count)
            {
                Logger.Error($"Invalid tab indices: left={leftIndex}, right={rightIndex}, tabCount={_tabs?.Count ?? 0}");
                return;
            }
            
            // Prevent comparing the same file with itself
            if (leftIndex == rightIndex)
            {
                StatusText.Text = "Please select different files to compare";
                Logger.Info("Same file selected in both dropdowns - skipping comparison");
                return;
            }
            
            var leftTab = _tabs[leftIndex];
            var rightTab = _tabs[rightIndex];
            
            LeftEditor.Text = leftTab.Editor.Text;
            RightEditor.Text = rightTab.Editor.Text;
            
            // Apply syntax highlighting
            var currentTheme = GetCurrentTheme();
            LeftEditor.SyntaxHighlighting = ThemeSyntaxHighlighting.GetHighlightingForTheme(currentTheme);
            RightEditor.SyntaxHighlighting = ThemeSyntaxHighlighting.GetHighlightingForTheme(currentTheme);
            
            // Perform diff
            _differences = PerformDiff(leftTab.Editor.Text, rightTab.Editor.Text);
            _currentDiffIndex = -1;
            
            // Apply diff highlighting (on top of syntax highlighting)
            LeftEditor.TextArea.TextView.LineTransformers.Clear();
            RightEditor.TextArea.TextView.LineTransformers.Clear();
            
            LeftEditor.TextArea.TextView.LineTransformers.Add(new DiffHighlighter(_differences, true));
            RightEditor.TextArea.TextView.LineTransformers.Add(new DiffHighlighter(_differences, false));
            
            // Update status
            var addedCount = _differences.Count(d => d.Type == DiffType.Added);
            var deletedCount = _differences.Count(d => d.Type == DiffType.Deleted);
            var modifiedCount = _differences.Count(d => d.Type == DiffType.Modified);
            var totalDiffs = addedCount + deletedCount + modifiedCount;
            
            StatusText.Text = $"{totalDiffs} difference(s) found: {addedCount} added, {deletedCount} deleted, {modifiedCount} modified";
            
            Logger.Info($"Compared files: {totalDiffs} differences found");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to compare files", ex);
            MessageBox.Show($"Error comparing files: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
    
    private List<DiffLine> PerformDiff(string leftText, string rightText)
    {
        var leftLines = leftText.Split('\n');
        var rightLines = rightText.Split('\n');
        var diffs = new List<DiffLine>();
        
        // Quick check: if texts are identical, return all unchanged
        if (leftText == rightText)
        {
            for (int i = 0; i < leftLines.Length; i++)
            {
                diffs.Add(new DiffLine
                {
                    LeftLineNumber = i + 1,
                    RightLineNumber = i + 1,
                    Type = DiffType.Unchanged
                });
            }
            Logger.Info($"Files are identical - {leftLines.Length} lines");
            return diffs;
        }
        
        // For very large files, use a simpler line-by-line comparison
        const int MAX_LCS_SIZE = 10000; // Limit to prevent memory issues
        if (leftLines.Length > MAX_LCS_SIZE || rightLines.Length > MAX_LCS_SIZE)
        {
            Logger.Info($"Large file comparison ({leftLines.Length} vs {rightLines.Length} lines) - using simple diff");
            return PerformSimpleDiff(leftLines, rightLines);
        }
        
        // Use Longest Common Subsequence (LCS) algorithm for better diff
        var lcs = ComputeLCS(leftLines, rightLines);
        
        int leftIndex = 0, rightIndex = 0;
        int lcsIndex = 0;
        
        while (leftIndex < leftLines.Length || rightIndex < rightLines.Length)
        {
            if (lcsIndex < lcs.Count && 
                leftIndex < leftLines.Length && 
                rightIndex < rightLines.Length &&
                leftLines[leftIndex] == lcs[lcsIndex] && 
                rightLines[rightIndex] == lcs[lcsIndex])
            {
                // Lines match - unchanged
                diffs.Add(new DiffLine
                {
                    LeftLineNumber = leftIndex + 1,
                    RightLineNumber = rightIndex + 1,
                    Type = DiffType.Unchanged
                });
                leftIndex++;
                rightIndex++;
                lcsIndex++;
            }
            else if (lcsIndex < lcs.Count && 
                     rightIndex < rightLines.Length && 
                     rightLines[rightIndex] == lcs[lcsIndex])
            {
                // Line was deleted from left
                diffs.Add(new DiffLine
                {
                    LeftLineNumber = leftIndex + 1,
                    RightLineNumber = -1,
                    Type = DiffType.Deleted
                });
                leftIndex++;
            }
            else if (lcsIndex < lcs.Count && 
                     leftIndex < leftLines.Length && 
                     leftLines[leftIndex] == lcs[lcsIndex])
            {
                // Line was added to right
                diffs.Add(new DiffLine
                {
                    LeftLineNumber = -1,
                    RightLineNumber = rightIndex + 1,
                    Type = DiffType.Added
                });
                rightIndex++;
            }
            else if (leftIndex < leftLines.Length && rightIndex < rightLines.Length)
            {
                // Lines are different - modified
                diffs.Add(new DiffLine
                {
                    LeftLineNumber = leftIndex + 1,
                    RightLineNumber = rightIndex + 1,
                    Type = DiffType.Modified
                });
                leftIndex++;
                rightIndex++;
            }
            else if (leftIndex < leftLines.Length)
            {
                // Remaining lines in left are deleted
                diffs.Add(new DiffLine
                {
                    LeftLineNumber = leftIndex + 1,
                    RightLineNumber = -1,
                    Type = DiffType.Deleted
                });
                leftIndex++;
            }
            else if (rightIndex < rightLines.Length)
            {
                // Remaining lines in right are added
                diffs.Add(new DiffLine
                {
                    LeftLineNumber = -1,
                    RightLineNumber = rightIndex + 1,
                    Type = DiffType.Added
                });
                rightIndex++;
            }
        }
        
        return diffs;
    }
    
    private List<DiffLine> PerformSimpleDiff(string[] leftLines, string[] rightLines)
    {
        // Simple line-by-line comparison for large files
        var diffs = new List<DiffLine>();
        int maxLines = Math.Max(leftLines.Length, rightLines.Length);
        
        for (int i = 0; i < maxLines; i++)
        {
            if (i < leftLines.Length && i < rightLines.Length)
            {
                if (leftLines[i] == rightLines[i])
                {
                    diffs.Add(new DiffLine
                    {
                        LeftLineNumber = i + 1,
                        RightLineNumber = i + 1,
                        Type = DiffType.Unchanged
                    });
                }
                else
                {
                    diffs.Add(new DiffLine
                    {
                        LeftLineNumber = i + 1,
                        RightLineNumber = i + 1,
                        Type = DiffType.Modified
                    });
                }
            }
            else if (i < leftLines.Length)
            {
                diffs.Add(new DiffLine
                {
                    LeftLineNumber = i + 1,
                    RightLineNumber = -1,
                    Type = DiffType.Deleted
                });
            }
            else
            {
                diffs.Add(new DiffLine
                {
                    LeftLineNumber = -1,
                    RightLineNumber = i + 1,
                    Type = DiffType.Added
                });
            }
        }
        
        return diffs;
    }
    
    private List<string> ComputeLCS(string[] left, string[] right)
    {
        int m = left.Length;
        int n = right.Length;
        int[,] dp = new int[m + 1, n + 1];
        
        // Build LCS table
        for (int i = 1; i <= m; i++)
        {
            for (int j = 1; j <= n; j++)
            {
                if (left[i - 1] == right[j - 1])
                {
                    dp[i, j] = dp[i - 1, j - 1] + 1;
                }
                else
                {
                    dp[i, j] = Math.Max(dp[i - 1, j], dp[i, j - 1]);
                }
            }
        }
        
        // Backtrack to find LCS
        var lcs = new List<string>();
        int x = m, y = n;
        
        while (x > 0 && y > 0)
        {
            if (left[x - 1] == right[y - 1])
            {
                lcs.Insert(0, left[x - 1]);
                x--;
                y--;
            }
            else if (dp[x - 1, y] > dp[x, y - 1])
            {
                x--;
            }
            else
            {
                y--;
            }
        }
        
        return lcs;
    }
    
    private void OnPreviousDifference(object sender, RoutedEventArgs e)
    {
        var diffLines = _differences.Where(d => d.Type != DiffType.Unchanged).ToList();
        if (diffLines.Count == 0) return;
        
        _currentDiffIndex--;
        if (_currentDiffIndex < 0)
            _currentDiffIndex = diffLines.Count - 1;
        
        ScrollToDifference(diffLines[_currentDiffIndex]);
    }
    
    private void OnNextDifference(object sender, RoutedEventArgs e)
    {
        var diffLines = _differences.Where(d => d.Type != DiffType.Unchanged).ToList();
        if (diffLines.Count == 0) return;
        
        _currentDiffIndex++;
        if (_currentDiffIndex >= diffLines.Count)
            _currentDiffIndex = 0;
        
        ScrollToDifference(diffLines[_currentDiffIndex]);
    }
    
    private void ScrollToDifference(DiffLine diff)
    {
        try
        {
            int lineToScroll = diff.LeftLineNumber > 0 ? diff.LeftLineNumber : diff.RightLineNumber;
            if (lineToScroll > 0)
            {
                LeftEditor.ScrollToLine(lineToScroll);
                LeftEditor.TextArea.Caret.Line = lineToScroll;
                
                // Highlight the line briefly
                StatusText.Text = $"Difference at line {lineToScroll} - {diff.Type}";
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to scroll to difference", ex);
        }
    }
    
    private void OnMergeAllLeft(object sender, RoutedEventArgs e)
    {
        try
        {
            // Copy all content from right to left
            LeftEditor.Text = RightEditor.Text;
            RefreshDiff();
            StatusText.Text = "Merged all content from right to left";
            Logger.Info("Merged all content from right to left");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to merge all left", ex);
            MessageBox.Show($"Error merging: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
    
    private void OnMergeAllRight(object sender, RoutedEventArgs e)
    {
        try
        {
            // Copy all content from left to right
            RightEditor.Text = LeftEditor.Text;
            RefreshDiff();
            StatusText.Text = "Merged all content from left to right";
            Logger.Info("Merged all content from left to right");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to merge all right", ex);
            MessageBox.Show($"Error merging: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
    
    private void OnMergeSelectedLeft(object sender, RoutedEventArgs e)
    {
        try
        {
            // Find diff at current cursor position (either editor)
            var currentLine = Math.Max(LeftEditor.TextArea.Caret.Line, RightEditor.TextArea.Caret.Line);
            var currentDiff = FindDiffAtLine(currentLine);
            
            if (currentDiff == null)
            {
                StatusText.Text = "No difference at current line. Click on a highlighted line first.";
                return;
            }
            
            MergeDiffBlock(currentDiff, fromRight: true);
            RefreshDiff();
            StatusText.Text = $"Merged difference at line {(currentDiff.LeftLineNumber > 0 ? currentDiff.LeftLineNumber : currentDiff.RightLineNumber)}";
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to merge selected left", ex);
            MessageBox.Show($"Error merging: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
    
    private void OnMergeSelectedRight(object sender, RoutedEventArgs e)
    {
        try
        {
            // Find diff at current cursor position (either editor)
            var currentLine = Math.Max(LeftEditor.TextArea.Caret.Line, RightEditor.TextArea.Caret.Line);
            var currentDiff = FindDiffAtLine(currentLine);
            
            if (currentDiff == null)
            {
                StatusText.Text = "No difference at current line. Click on a highlighted line first.";
                return;
            }
            
            MergeDiffBlock(currentDiff, fromRight: false);
            RefreshDiff();
            StatusText.Text = $"Merged difference at line {(currentDiff.LeftLineNumber > 0 ? currentDiff.LeftLineNumber : currentDiff.RightLineNumber)}";
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to merge selected right", ex);
            MessageBox.Show($"Error merging: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
    
    private DiffLine? FindDiffAtLine(int lineNumber)
    {
        // Try to find a diff at or near the current line
        return _differences.FirstOrDefault(d => 
            d.Type != DiffType.Unchanged && 
            (d.LeftLineNumber == lineNumber || d.RightLineNumber == lineNumber));
    }
    
    private void MergeDiffBlock(DiffLine diff, bool fromRight)
    {
        var leftLines = LeftEditor.Text.Split('\n').ToList();
        var rightLines = RightEditor.Text.Split('\n').ToList();
        
        if (fromRight)
        {
            // Copy from right to left
            if (diff.Type == DiffType.Added && diff.RightLineNumber > 0 && diff.RightLineNumber <= rightLines.Count)
            {
                // Line exists in right, insert into left
                var lineIndex = diff.LeftLineNumber > 0 ? diff.LeftLineNumber - 1 : leftLines.Count;
                leftLines.Insert(lineIndex, rightLines[diff.RightLineNumber - 1]);
                LeftEditor.Text = string.Join("\n", leftLines);
            }
            else if (diff.Type == DiffType.Deleted && diff.LeftLineNumber > 0 && diff.LeftLineNumber <= leftLines.Count)
            {
                // Line exists in left but not right, remove from left
                leftLines.RemoveAt(diff.LeftLineNumber - 1);
                LeftEditor.Text = string.Join("\n", leftLines);
            }
            else if (diff.Type == DiffType.Modified && diff.LeftLineNumber > 0 && diff.RightLineNumber > 0)
            {
                // Replace left line with right line
                if (diff.LeftLineNumber <= leftLines.Count && diff.RightLineNumber <= rightLines.Count)
                {
                    leftLines[diff.LeftLineNumber - 1] = rightLines[diff.RightLineNumber - 1];
                    LeftEditor.Text = string.Join("\n", leftLines);
                }
            }
        }
        else
        {
            // Copy from left to right
            if (diff.Type == DiffType.Deleted && diff.LeftLineNumber > 0 && diff.LeftLineNumber <= leftLines.Count)
            {
                // Line exists in left, insert into right
                var lineIndex = diff.RightLineNumber > 0 ? diff.RightLineNumber - 1 : rightLines.Count;
                rightLines.Insert(lineIndex, leftLines[diff.LeftLineNumber - 1]);
                RightEditor.Text = string.Join("\n", rightLines);
            }
            else if (diff.Type == DiffType.Added && diff.RightLineNumber > 0 && diff.RightLineNumber <= rightLines.Count)
            {
                // Line exists in right but not left, remove from right
                rightLines.RemoveAt(diff.RightLineNumber - 1);
                RightEditor.Text = string.Join("\n", rightLines);
            }
            else if (diff.Type == DiffType.Modified && diff.LeftLineNumber > 0 && diff.RightLineNumber > 0)
            {
                // Replace right line with left line
                if (diff.LeftLineNumber <= leftLines.Count && diff.RightLineNumber <= rightLines.Count)
                {
                    rightLines[diff.RightLineNumber - 1] = leftLines[diff.LeftLineNumber - 1];
                    RightEditor.Text = string.Join("\n", rightLines);
                }
            }
        }
    }
    
    private void OnSaveLeft(object sender, RoutedEventArgs e)
    {
        try
        {
            var leftIndex = LeftFileComboBox.SelectedIndex;
            if (leftIndex >= 0 && leftIndex < _tabs.Count)
            {
                _tabs[leftIndex].Editor.Text = LeftEditor.Text;
                var fileName = Path.GetFileName(_tabs[leftIndex].FilePath) ?? "untitled";
                StatusText.Text = $"Saved changes to {fileName}";
                Logger.Info($"Saved left editor content to tab: {fileName}");
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to save left", ex);
            MessageBox.Show($"Error saving: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
    
    private void OnSaveRight(object sender, RoutedEventArgs e)
    {
        try
        {
            var rightIndex = RightFileComboBox.SelectedIndex;
            if (rightIndex >= 0 && rightIndex < _tabs.Count)
            {
                _tabs[rightIndex].Editor.Text = RightEditor.Text;
                var fileName = Path.GetFileName(_tabs[rightIndex].FilePath) ?? "untitled";
                StatusText.Text = $"Saved changes to {fileName}";
                Logger.Info($"Saved right editor content to tab: {fileName}");
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to save right", ex);
            MessageBox.Show($"Error saving: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
    
    private void RefreshDiff()
    {
        try
        {
            // Re-perform diff with current editor content
            _differences = PerformDiff(LeftEditor.Text, RightEditor.Text);
            _currentDiffIndex = -1;
            
            // Reapply diff highlighting
            LeftEditor.TextArea.TextView.LineTransformers.Clear();
            RightEditor.TextArea.TextView.LineTransformers.Clear();
            
            LeftEditor.TextArea.TextView.LineTransformers.Add(new DiffHighlighter(_differences, true));
            RightEditor.TextArea.TextView.LineTransformers.Add(new DiffHighlighter(_differences, false));
            
            // Update status
            var addedCount = _differences.Count(d => d.Type == DiffType.Added);
            var deletedCount = _differences.Count(d => d.Type == DiffType.Deleted);
            var modifiedCount = _differences.Count(d => d.Type == DiffType.Modified);
            var totalDiffs = addedCount + deletedCount + modifiedCount;
            
            if (totalDiffs == 0)
            {
                StatusText.Text = "Files are identical";
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to refresh diff", ex);
        }
    }
    
    private void LoadAndApplyTheme()
    {
        try
        {
            var theme = GetCurrentTheme();
            ApplyTheme(theme);
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to load theme for CompareDialog", ex);
        }
    }
    
    private string GetCurrentTheme()
    {
        try
        {
            var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var prefsFile = Path.Combine(appDataPath, "RitoShark", "Jade", "preferences.txt");
            
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                if (content.Contains("Theme="))
                {
                    var lines = content.Split('\n');
                    foreach (var line in lines)
                    {
                        if (line.StartsWith("Theme="))
                        {
                            return line.Substring(6).Trim();
                        }
                    }
                }
            }
        }
        catch { }
        
        return "Default";
    }
    
    private void ApplyTheme(string theme)
    {
        SolidColorBrush bgColor, editorBg, titleBarBg, textColor, selectionBg, comboBg, comboBorder, statusBarBg;
        Color lineNumberColor;
        
        switch (theme)
        {
            case "DarkBlue":
                bgColor = new SolidColorBrush(Color.FromRgb(15, 25, 40));
                editorBg = new SolidColorBrush(Color.FromRgb(20, 30, 45));
                titleBarBg = new SolidColorBrush(Color.FromRgb(25, 35, 50));
                selectionBg = new SolidColorBrush(Color.FromRgb(25, 35, 50));
                textColor = new SolidColorBrush(Color.FromRgb(220, 230, 240));
                lineNumberColor = Color.FromRgb(100, 140, 180);
                comboBg = new SolidColorBrush(Color.FromRgb(15, 25, 40));
                comboBorder = new SolidColorBrush(Color.FromRgb(30, 45, 65));
                statusBarBg = new SolidColorBrush(Color.FromRgb(0, 90, 158));
                break;
            case "DarkRed":
                bgColor = new SolidColorBrush(Color.FromRgb(40, 15, 20));
                editorBg = new SolidColorBrush(Color.FromRgb(45, 20, 25));
                titleBarBg = new SolidColorBrush(Color.FromRgb(50, 25, 30));
                selectionBg = new SolidColorBrush(Color.FromRgb(50, 25, 30));
                textColor = new SolidColorBrush(Color.FromRgb(240, 220, 225));
                lineNumberColor = Color.FromRgb(180, 100, 120);
                comboBg = new SolidColorBrush(Color.FromRgb(40, 15, 20));
                comboBorder = new SolidColorBrush(Color.FromRgb(65, 30, 40));
                statusBarBg = new SolidColorBrush(Color.FromRgb(158, 0, 40));
                break;
            case "LightPink":
                bgColor = new SolidColorBrush(Color.FromRgb(210, 165, 190)); // Match ThemesWindow bgColor
                editorBg = new SolidColorBrush(Color.FromRgb(210, 165, 190)); // Match bgColor
                titleBarBg = new SolidColorBrush(Color.FromRgb(180, 130, 160)); // Match ThemesWindow titleBarBg
                selectionBg = new SolidColorBrush(Color.FromRgb(180, 130, 160));
                textColor = new SolidColorBrush(Color.FromRgb(30, 15, 25)); // Match ThemesWindow textColor
                lineNumberColor = Color.FromRgb(80, 50, 70);
                comboBg = new SolidColorBrush(Color.FromRgb(200, 155, 180));
                comboBorder = new SolidColorBrush(Color.FromRgb(170, 120, 150));
                statusBarBg = new SolidColorBrush(Color.FromRgb(199, 21, 133)); // Match titleBarBg
                break;
            case "PastelBlue":
                bgColor = new SolidColorBrush(Color.FromRgb(210, 240, 255)); // Match ThemesWindow bgColor
                editorBg = new SolidColorBrush(Color.FromRgb(210, 240, 255)); // Match bgColor
                titleBarBg = new SolidColorBrush(Color.FromRgb(255, 240, 250)); // Match ThemesWindow titleBarBg
                selectionBg = new SolidColorBrush(Color.FromRgb(255, 240, 250));
                textColor = new SolidColorBrush(Color.FromRgb(40, 25, 60)); // Match ThemesWindow textColor
                lineNumberColor = Color.FromRgb(100, 80, 140);
                comboBg = new SolidColorBrush(Color.FromRgb(230, 245, 255));
                comboBorder = new SolidColorBrush(Color.FromRgb(180, 220, 245));
                statusBarBg = new SolidColorBrush(Color.FromRgb(80, 200, 255)); // Match titleBarBg
                break;
            case "VioletSorrow":
                bgColor = new SolidColorBrush(Color.FromRgb(18, 10, 35));
                editorBg = new SolidColorBrush(Color.FromRgb(22, 12, 42));
                titleBarBg = new SolidColorBrush(Color.FromRgb(28, 18, 52));
                selectionBg = new SolidColorBrush(Color.FromRgb(32, 20, 58));
                textColor = new SolidColorBrush(Color.FromRgb(185, 170, 215));
                lineNumberColor = Color.FromRgb(130, 100, 185);
                comboBg = new SolidColorBrush(Color.FromRgb(18, 10, 35));
                comboBorder = new SolidColorBrush(Color.FromRgb(70, 45, 110));
                statusBarBg = new SolidColorBrush(Color.FromRgb(65, 30, 120));
                break;
            case "ForestGreen":
                bgColor = new SolidColorBrush(Color.FromRgb(20, 35, 25));
                editorBg = new SolidColorBrush(Color.FromRgb(25, 45, 30));
                titleBarBg = new SolidColorBrush(Color.FromRgb(30, 50, 35));
                selectionBg = new SolidColorBrush(Color.FromRgb(30, 50, 35));
                textColor = new SolidColorBrush(Color.FromRgb(200, 230, 210));
                lineNumberColor = Color.FromRgb(100, 150, 120);
                comboBg = new SolidColorBrush(Color.FromRgb(20, 35, 25));
                comboBorder = new SolidColorBrush(Color.FromRgb(40, 70, 50));
                statusBarBg = new SolidColorBrush(Color.FromRgb(34, 139, 34));
                break;
            case "AMOLED":
                bgColor = new SolidColorBrush(Color.FromRgb(0, 0, 0));
                editorBg = new SolidColorBrush(Color.FromRgb(0, 0, 0));
                titleBarBg = new SolidColorBrush(Color.FromRgb(10, 10, 10));
                selectionBg = new SolidColorBrush(Color.FromRgb(10, 10, 10));
                textColor = new SolidColorBrush(Color.FromRgb(180, 180, 180));
                lineNumberColor = Color.FromRgb(100, 100, 100);
                comboBg = new SolidColorBrush(Color.FromRgb(5, 5, 5));
                comboBorder = new SolidColorBrush(Color.FromRgb(25, 25, 25));
                statusBarBg = new SolidColorBrush(Color.FromRgb(20, 20, 20));
                break;
            case "Void":
                bgColor = new SolidColorBrush(Color.FromRgb(10, 5, 20));
                editorBg = new SolidColorBrush(Color.FromRgb(15, 10, 30));
                titleBarBg = new SolidColorBrush(Color.FromRgb(20, 15, 40));
                selectionBg = new SolidColorBrush(Color.FromRgb(26, 15, 46));
                textColor = new SolidColorBrush(Color.FromRgb(180, 170, 220));
                lineNumberColor = Color.FromRgb(140, 120, 180);
                comboBg = new SolidColorBrush(Color.FromRgb(10, 5, 20));
                comboBorder = new SolidColorBrush(Color.FromRgb(35, 25, 60));
                statusBarBg = new SolidColorBrush(Color.FromRgb(25, 15, 80));
                break;
            default:
                bgColor = new SolidColorBrush(Color.FromRgb(30, 30, 30));
                editorBg = new SolidColorBrush(Color.FromRgb(30, 30, 30));
                titleBarBg = new SolidColorBrush(Color.FromRgb(37, 37, 38));
                selectionBg = new SolidColorBrush(Color.FromRgb(37, 37, 38));
                textColor = new SolidColorBrush(Color.FromRgb(212, 212, 212));
                lineNumberColor = Color.FromRgb(128, 128, 128);
                comboBg = new SolidColorBrush(Color.FromRgb(45, 45, 48));
                comboBorder = new SolidColorBrush(Color.FromRgb(62, 62, 66));
                statusBarBg = new SolidColorBrush(Color.FromRgb(0, 122, 204));
                break;
        }
        
        this.Background = bgColor;
        
        if (TitleBar != null)
            TitleBar.Background = titleBarBg;
        
        // Update file selection grid
        if (FileSelectionGrid != null)
        {
            FileSelectionGrid.Background = selectionBg;
            
            // Update TextBlocks in file selection
            foreach (var child in FileSelectionGrid.Children)
            {
                if (child is System.Windows.Controls.TextBlock tb)
                {
                    tb.Foreground = textColor;
                }
            }
        }
        
        // Update ComboBox colors in resources
        this.Resources["ComboBoxBackground"] = comboBg;
        this.Resources["ComboBoxForeground"] = textColor;
        this.Resources["ComboBoxBorder"] = comboBorder;
        this.Resources["ComboBoxHoverBackground"] = selectionBg;
        
        if (LeftFileComboBox != null)
        {
            LeftFileComboBox.Background = comboBg;
            LeftFileComboBox.Foreground = textColor;
            LeftFileComboBox.BorderBrush = comboBorder;
            LeftFileComboBox.UpdateLayout();
        }
        
        if (RightFileComboBox != null)
        {
            RightFileComboBox.Background = comboBg;
            RightFileComboBox.Foreground = textColor;
            RightFileComboBox.BorderBrush = comboBorder;
            RightFileComboBox.UpdateLayout();
        }
        
        // Update navigation buttons
        SolidColorBrush buttonBg, buttonHoverBg;
        switch (theme)
        {
            case "DarkBlue":
                buttonBg = new SolidColorBrush(Color.FromRgb(0, 90, 158));
                buttonHoverBg = new SolidColorBrush(Color.FromRgb(28, 151, 234));
                break;
            case "DarkRed":
                buttonBg = new SolidColorBrush(Color.FromRgb(158, 0, 40));
                buttonHoverBg = new SolidColorBrush(Color.FromRgb(200, 30, 70));
                break;
            case "LightPink":
                buttonBg = new SolidColorBrush(Color.FromRgb(140, 70, 120)); // Darker for better visibility
                buttonHoverBg = new SolidColorBrush(Color.FromRgb(160, 90, 140));
                break;
            case "PastelBlue":
                buttonBg = new SolidColorBrush(Color.FromRgb(60, 130, 200)); // Darker for better visibility
                buttonHoverBg = new SolidColorBrush(Color.FromRgb(80, 150, 220));
                break;
            case "VioletSorrow":
                buttonBg = new SolidColorBrush(Color.FromRgb(65, 30, 120));
                buttonHoverBg = new SolidColorBrush(Color.FromRgb(95, 55, 150));
                break;
            case "ForestGreen":
                buttonBg = new SolidColorBrush(Color.FromRgb(34, 139, 34));
                buttonHoverBg = new SolidColorBrush(Color.FromRgb(50, 170, 50));
                break;
            case "AMOLED":
                buttonBg = new SolidColorBrush(Color.FromRgb(40, 40, 40));
                buttonHoverBg = new SolidColorBrush(Color.FromRgb(60, 60, 60));
                break;
            case "Void":
                buttonBg = new SolidColorBrush(Color.FromRgb(25, 15, 80));
                buttonHoverBg = new SolidColorBrush(Color.FromRgb(40, 30, 100));
                break;
            default:
                buttonBg = new SolidColorBrush(Color.FromRgb(0, 122, 204));
                buttonHoverBg = new SolidColorBrush(Color.FromRgb(28, 151, 234));
                break;
        }
        
        var buttonStyle = new Style(typeof(System.Windows.Controls.Button));
        buttonStyle.Setters.Add(new Setter(System.Windows.Controls.Button.BackgroundProperty, buttonBg));
        buttonStyle.Setters.Add(new Setter(System.Windows.Controls.Button.ForegroundProperty, new SolidColorBrush(Colors.White)));
        buttonStyle.Setters.Add(new Setter(System.Windows.Controls.Button.BorderThicknessProperty, new Thickness(0)));
        buttonStyle.Setters.Add(new Setter(System.Windows.Controls.Button.CursorProperty, Cursors.Hand));
        
        var hoverTrigger = new Trigger { Property = System.Windows.Controls.Button.IsMouseOverProperty, Value = true };
        hoverTrigger.Setters.Add(new Setter(System.Windows.Controls.Button.BackgroundProperty, buttonHoverBg));
        buttonStyle.Triggers.Add(hoverTrigger);
        
        this.Resources[typeof(System.Windows.Controls.Button)] = buttonStyle;
        
        // Update status bar
        if (StatusBarBorder != null)
        {
            StatusBarBorder.Background = statusBarBg;
        }
        
        if (StatusText != null)
        {
            // Use dark text for light themes
            var statusTextColor = (theme == "LightPink" || theme == "PastelBlue") 
                ? new SolidColorBrush(Color.FromRgb(30, 20, 40))
                : new SolidColorBrush(Colors.White);
            StatusText.Foreground = statusTextColor;
        }
        
        // Update editor borders (which contain the actual background)
        var leftEditorBorder = this.FindName("LeftEditorBorder") as System.Windows.Controls.Border;
        if (leftEditorBorder != null)
        {
            leftEditorBorder.Background = editorBg;
        }
        
        var rightEditorBorder = this.FindName("RightEditorBorder") as System.Windows.Controls.Border;
        if (rightEditorBorder != null)
        {
            rightEditorBorder.Background = editorBg;
        }
        
        if (LeftEditor != null)
        {
            LeftEditor.Foreground = textColor;
            LeftEditor.LineNumbersForeground = new SolidColorBrush(lineNumberColor);
        }
        
        if (RightEditor != null)
        {
            RightEditor.Foreground = textColor;
            RightEditor.LineNumbersForeground = new SolidColorBrush(lineNumberColor);
        }
        
        // Update scrollbar colors based on theme
        UpdateScrollBarColors(theme);
    }
    
    private void UpdateScrollBarColors(string theme)
    {
        SolidColorBrush trackBg, thumbBg, thumbHoverBg;
        
        switch (theme)
        {
            case "DarkBlue":
                trackBg = new SolidColorBrush(Color.FromRgb(30, 40, 55));
                thumbBg = new SolidColorBrush(Color.FromRgb(60, 90, 130));
                thumbHoverBg = new SolidColorBrush(Color.FromRgb(80, 120, 170));
                break;
            case "DarkRed":
                trackBg = new SolidColorBrush(Color.FromRgb(55, 25, 35));
                thumbBg = new SolidColorBrush(Color.FromRgb(130, 60, 80));
                thumbHoverBg = new SolidColorBrush(Color.FromRgb(170, 80, 110));
                break;
            case "LightPink":
                trackBg = new SolidColorBrush(Color.FromRgb(220, 175, 200));
                thumbBg = new SolidColorBrush(Color.FromRgb(180, 130, 160));
                thumbHoverBg = new SolidColorBrush(Color.FromRgb(160, 110, 140));
                break;
            case "PastelBlue":
                trackBg = new SolidColorBrush(Color.FromRgb(200, 235, 250));
                thumbBg = new SolidColorBrush(Color.FromRgb(150, 200, 230));
                thumbHoverBg = new SolidColorBrush(Color.FromRgb(120, 180, 220));
                break;
            case "VioletSorrow":
                trackBg = new SolidColorBrush(Color.FromRgb(28, 18, 52));
                thumbBg = new SolidColorBrush(Color.FromRgb(70, 45, 110));
                thumbHoverBg = new SolidColorBrush(Color.FromRgb(95, 65, 145));
                break;
            case "ForestGreen":
                trackBg = new SolidColorBrush(Color.FromRgb(35, 55, 40));
                thumbBg = new SolidColorBrush(Color.FromRgb(70, 120, 85));
                thumbHoverBg = new SolidColorBrush(Color.FromRgb(90, 150, 110));
                break;
            case "AMOLED":
                trackBg = new SolidColorBrush(Color.FromRgb(15, 15, 15));
                thumbBg = new SolidColorBrush(Color.FromRgb(40, 40, 40));
                thumbHoverBg = new SolidColorBrush(Color.FromRgb(60, 60, 60));
                break;
            case "Void":
                trackBg = new SolidColorBrush(Color.FromRgb(25, 20, 45));
                thumbBg = new SolidColorBrush(Color.FromRgb(60, 50, 100));
                thumbHoverBg = new SolidColorBrush(Color.FromRgb(80, 70, 130));
                break;
            default:
                trackBg = new SolidColorBrush(Color.FromRgb(62, 62, 66));
                thumbBg = new SolidColorBrush(Color.FromRgb(104, 104, 104));
                thumbHoverBg = new SolidColorBrush(Color.FromRgb(158, 158, 158));
                break;
        }
        
        this.Resources["ScrollBarTrackBrush"] = trackBg;
        this.Resources["ScrollBarThumbBrush"] = thumbBg;
        this.Resources["ScrollBarThumbHoverBrush"] = thumbHoverBg;
    }
    
    private void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2)
        {
            MaximizeWindow(sender, e);
        }
        else
        {
            DragMove();
        }
    }
    
    private void MinimizeWindow(object sender, RoutedEventArgs e)
    {
        WindowState = WindowState.Minimized;
    }
    
    private void MaximizeWindow(object sender, RoutedEventArgs e)
    {
        WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
    }
    
    private void CloseWindow(object sender, RoutedEventArgs e)
    {
        Close();
    }
    
    // Fix maximize to respect taskbar and prevent clipping
    [DllImport("user32.dll")]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
    
    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);
    
    private const uint MONITOR_DEFAULTTONEAREST = 2;
    
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
    
    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO
    {
        public uint Size;
        public RECT Monitor;
        public RECT WorkArea;
        public uint Flags;
    }
    
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X;
        public int Y;
    }
    
    [StructLayout(LayoutKind.Sequential)]
    public struct MINMAXINFO
    {
        public POINT ptReserved;
        public POINT ptMaxSize;
        public POINT ptMaxPosition;
        public POINT ptMinTrackSize;
        public POINT ptMaxTrackSize;
    }
    
    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        var handle = new WindowInteropHelper(this).Handle;
        var source = HwndSource.FromHwnd(handle);
        source?.AddHook(WndProc);
    }
    
    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        const int WM_GETMINMAXINFO = 0x0024;
        
        if (msg == WM_GETMINMAXINFO)
        {
            var mmi = Marshal.PtrToStructure<MINMAXINFO>(lParam);
            var monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            
            if (monitor != IntPtr.Zero)
            {
                var monitorInfo = new MONITORINFO { Size = (uint)Marshal.SizeOf(typeof(MONITORINFO)) };
                if (GetMonitorInfo(monitor, ref monitorInfo))
                {
                    var workArea = monitorInfo.WorkArea;
                    var monitorArea = monitorInfo.Monitor;
                    
                    mmi.ptMaxPosition.X = workArea.Left - monitorArea.Left;
                    mmi.ptMaxPosition.Y = workArea.Top - monitorArea.Top;
                    mmi.ptMaxSize.X = workArea.Right - workArea.Left;
                    // Leave 1 pixel gap at bottom for hidden taskbar access
                    mmi.ptMaxSize.Y = workArea.Bottom - workArea.Top - 1;
                }
            }
            
            Marshal.StructureToPtr(mmi, lParam, true);
            handled = true;
        }
        
        return IntPtr.Zero;
    }
    
    private void OnWindowStateChanged(object? sender, EventArgs e)
    {
        // Adjust margin when maximized for taskbar access
        if (WindowState == WindowState.Maximized)
        {
            // Only 1px at bottom for taskbar gap
            RootGrid.Margin = new Thickness(0, 0, 0, 1);
        }
        else
        {
            RootGrid.Margin = new Thickness(0);
        }
    }
}

public static class EditorExtensions
{
    public static System.Windows.Controls.ScrollViewer? GetScrollViewer(this ICSharpCode.AvalonEdit.TextEditor editor)
    {
        // AvalonEdit structure: TextEditor -> Border -> ScrollViewer
        if (VisualTreeHelper.GetChildrenCount(editor) > 0)
        {
            var border = VisualTreeHelper.GetChild(editor, 0);
            if (border != null && VisualTreeHelper.GetChildrenCount(border) > 0)
            {
                return VisualTreeHelper.GetChild(border, 0) as System.Windows.Controls.ScrollViewer;
            }
        }
        return null;
    }
}
