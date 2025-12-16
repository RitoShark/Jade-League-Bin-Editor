using System;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Jade.Services;

namespace Jade.Windows;

public partial class ReplaceDialog : Window
{
    private readonly dynamic _editor;
    private int _lastSearchIndex = 0;
    
    public ReplaceDialog(object editor)
    {
        InitializeComponent();
        _editor = editor;
        
        LoadAndApplyTheme();
        
        Loaded += (s, e) =>
        {
            PositionAtBottomRight();
            FindTextBox.Focus();
        };
    }
    
    private void PositionAtBottomRight()
    {
        try
        {
            if (Owner != null)
            {
                // Position at bottom right of owner window with padding
                var rightPadding = 20;
                var bottomPadding = 44; // Extra padding to avoid scrollbar
                Left = Owner.Left + Owner.ActualWidth - ActualWidth - rightPadding;
                Top = Owner.Top + Owner.ActualHeight - ActualHeight - bottomPadding;
                
                // Make sure it's on screen
                var screenWidth = SystemParameters.PrimaryScreenWidth;
                var screenHeight = SystemParameters.PrimaryScreenHeight;
                
                if (Left < 0) Left = rightPadding;
                if (Top < 0) Top = rightPadding;
                if (Left + ActualWidth > screenWidth) Left = screenWidth - ActualWidth - rightPadding;
                if (Top + ActualHeight > screenHeight) Top = screenHeight - ActualHeight - bottomPadding;
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to position replace dialog", ex);
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
            Logger.Error("Failed to load theme for ReplaceDialog", ex);
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
        SolidColorBrush bgColor, titleBarBg, textColor, inputBg, inputBorder, buttonBg, buttonHoverBg;
        SolidColorBrush buttonFg = Brushes.White; // Default button text color
        
        if (theme == "DarkBlue")
        {
            bgColor = new SolidColorBrush(Color.FromRgb(20, 30, 45));
            titleBarBg = new SolidColorBrush(Color.FromRgb(25, 35, 50));
            textColor = new SolidColorBrush(Color.FromRgb(220, 230, 240));
            inputBg = new SolidColorBrush(Color.FromRgb(15, 25, 40));
            inputBorder = new SolidColorBrush(Color.FromRgb(30, 45, 65));
            buttonBg = new SolidColorBrush(Color.FromRgb(0, 90, 158));
            buttonHoverBg = new SolidColorBrush(Color.FromRgb(28, 151, 234));
        }
        else if (theme == "DarkRed")
        {
            bgColor = new SolidColorBrush(Color.FromRgb(45, 20, 25));
            titleBarBg = new SolidColorBrush(Color.FromRgb(50, 25, 30));
            textColor = new SolidColorBrush(Color.FromRgb(240, 220, 225));
            inputBg = new SolidColorBrush(Color.FromRgb(40, 15, 20));
            inputBorder = new SolidColorBrush(Color.FromRgb(65, 30, 40));
            buttonBg = new SolidColorBrush(Color.FromRgb(158, 0, 40));
            buttonHoverBg = new SolidColorBrush(Color.FromRgb(200, 30, 70));
        }
        else if (theme == "LightPink")
        {
            bgColor = new SolidColorBrush(Color.FromRgb(210, 165, 190));
            titleBarBg = new SolidColorBrush(Color.FromRgb(180, 130, 160));
            textColor = Brushes.Black; // Black text for contrast
            inputBg = new SolidColorBrush(Color.FromRgb(230, 190, 210));
            inputBorder = new SolidColorBrush(Color.FromRgb(170, 110, 150));
            buttonBg = new SolidColorBrush(Color.FromRgb(199, 21, 133));
            buttonHoverBg = new SolidColorBrush(Color.FromRgb(219, 51, 163));
        }
        else if (theme == "PastelBlue")
        {
            bgColor = new SolidColorBrush(Color.FromRgb(210, 240, 255));
            titleBarBg = new SolidColorBrush(Color.FromRgb(255, 240, 250));
            textColor = Brushes.Black; // Black text for contrast
            inputBg = new SolidColorBrush(Color.FromRgb(235, 250, 255));
            inputBorder = new SolidColorBrush(Color.FromRgb(150, 180, 230));
            buttonBg = new SolidColorBrush(Color.FromRgb(80, 200, 255));
            buttonHoverBg = new SolidColorBrush(Color.FromRgb(100, 220, 255));
            buttonFg = Brushes.Black; // Black button text for light theme
        }
        else if (theme == "ForestGreen")
        {
            bgColor = new SolidColorBrush(Color.FromRgb(25, 45, 30));
            titleBarBg = new SolidColorBrush(Color.FromRgb(30, 50, 35));
            textColor = new SolidColorBrush(Color.FromRgb(200, 230, 210));
            inputBg = new SolidColorBrush(Color.FromRgb(20, 35, 25));
            inputBorder = new SolidColorBrush(Color.FromRgb(40, 70, 50));
            buttonBg = new SolidColorBrush(Color.FromRgb(34, 139, 34));
            buttonHoverBg = new SolidColorBrush(Color.FromRgb(50, 170, 50));
        }
        else if (theme == "AMOLED")
        {
            bgColor = new SolidColorBrush(Color.FromRgb(0, 0, 0));
            titleBarBg = new SolidColorBrush(Color.FromRgb(10, 10, 10));
            textColor = new SolidColorBrush(Color.FromRgb(180, 180, 180));
            inputBg = new SolidColorBrush(Color.FromRgb(5, 5, 5));
            inputBorder = new SolidColorBrush(Color.FromRgb(25, 25, 25));
            buttonBg = new SolidColorBrush(Color.FromRgb(40, 40, 40));
            buttonHoverBg = new SolidColorBrush(Color.FromRgb(60, 60, 60));
        }
        else if (theme == "Void")
        {
            bgColor = new SolidColorBrush(Color.FromRgb(15, 10, 30));
            titleBarBg = new SolidColorBrush(Color.FromRgb(20, 15, 40));
            textColor = new SolidColorBrush(Color.FromRgb(180, 170, 220));
            inputBg = new SolidColorBrush(Color.FromRgb(10, 5, 20));
            inputBorder = new SolidColorBrush(Color.FromRgb(35, 25, 60));
            buttonBg = new SolidColorBrush(Color.FromRgb(25, 15, 80));
            buttonHoverBg = new SolidColorBrush(Color.FromRgb(40, 30, 100));
        }
        else if (theme == "VioletSorrow")
        {
            bgColor = new SolidColorBrush(Color.FromRgb(22, 12, 42));
            titleBarBg = new SolidColorBrush(Color.FromRgb(32, 20, 58));
            textColor = new SolidColorBrush(Color.FromRgb(185, 170, 215));
            inputBg = new SolidColorBrush(Color.FromRgb(18, 10, 35));
            inputBorder = new SolidColorBrush(Color.FromRgb(70, 45, 110));
            buttonBg = new SolidColorBrush(Color.FromRgb(65, 30, 120));
            buttonHoverBg = new SolidColorBrush(Color.FromRgb(95, 55, 150));
        }
        else // Default
        {
            bgColor = new SolidColorBrush(Color.FromRgb(30, 30, 30));
            titleBarBg = new SolidColorBrush(Color.FromRgb(37, 37, 38));
            textColor = new SolidColorBrush(Color.FromRgb(212, 212, 212));
            inputBg = new SolidColorBrush(Color.FromRgb(45, 45, 48));
            inputBorder = new SolidColorBrush(Color.FromRgb(62, 62, 66));
            buttonBg = new SolidColorBrush(Color.FromRgb(0, 122, 204));
            buttonHoverBg = new SolidColorBrush(Color.FromRgb(28, 151, 234));
        }
        
        // Apply colors
        this.Background = bgColor;
        
        // Update title bar
        var titleBar = this.FindName("TitleBar") as Border;
        if (titleBar != null)
        {
            titleBar.Background = titleBarBg;
        }
        
        // Update all TextBlocks
        UpdateTextBlockColors(this, textColor);
        
        // Update TextBoxes
        if (FindTextBox != null)
        {
            FindTextBox.Background = inputBg;
            FindTextBox.Foreground = textColor;
            FindTextBox.BorderBrush = inputBorder;
        }
        if (ReplaceTextBox != null)
        {
            ReplaceTextBox.Background = inputBg;
            ReplaceTextBox.Foreground = textColor;
            ReplaceTextBox.BorderBrush = inputBorder;
        }
        
        // Update CheckBoxes
        if (MatchCaseCheckBox != null)
        {
            MatchCaseCheckBox.Foreground = textColor;
        }
        if (WholeWordCheckBox != null)
        {
            WholeWordCheckBox.Foreground = textColor;
        }
        
        // Update button style for hover effects
        var buttonStyle = new Style(typeof(Button));
        buttonStyle.Setters.Add(new Setter(Button.BackgroundProperty, buttonBg));
        buttonStyle.Setters.Add(new Setter(Button.ForegroundProperty, buttonFg));
        buttonStyle.Setters.Add(new Setter(Button.BorderThicknessProperty, new Thickness(0)));
        buttonStyle.Setters.Add(new Setter(Button.PaddingProperty, new Thickness(12, 8, 12, 8)));
        buttonStyle.Setters.Add(new Setter(Button.FontSizeProperty, 14.0));
        buttonStyle.Setters.Add(new Setter(Button.CursorProperty, Cursors.Hand));
        
        var trigger = new Trigger { Property = Button.IsMouseOverProperty, Value = true };
        trigger.Setters.Add(new Setter(Button.BackgroundProperty, buttonHoverBg));
        buttonStyle.Triggers.Add(trigger);
        
        this.Resources[typeof(Button)] = buttonStyle;
    }
    
    private void UpdateTextBlockColors(DependencyObject parent, SolidColorBrush color)
    {
        int childCount = VisualTreeHelper.GetChildrenCount(parent);
        for (int i = 0; i < childCount; i++)
        {
            var child = VisualTreeHelper.GetChild(parent, i);
            if (child is TextBlock textBlock)
            {
                textBlock.Foreground = color;
            }
            UpdateTextBlockColors(child, color);
        }
    }
    
    private void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2)
        {
            return; // No maximize for replace dialog
        }
        else
        {
            DragMove();
        }
    }
    
    private void OnSearchKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            e.Handled = true;
            OnFindNext(sender, e);
        }
        else if (e.Key == Key.Escape)
        {
            e.Handled = true;
            var owner = Owner;
            Owner = null;
            owner?.Activate();
            Close();
        }
    }
    
    private void OnFindNext(object sender, RoutedEventArgs e)
    {
        FindText(forward: true);
    }
    
    private void OnReplace(object sender, RoutedEventArgs e)
    {
        try
        {
            var findText = FindTextBox.Text;
            var replaceText = ReplaceTextBox.Text;
            
            if (string.IsNullOrEmpty(findText))
            {
                MessageBox.Show("Please enter text to find.", "Replace", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }
            
            // Check if current selection matches the find text
            var selectedText = _editor.SelectedText;
            var matchCase = MatchCaseCheckBox.IsChecked == true;
            var comparison = matchCase ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;
            
            if (!string.IsNullOrEmpty(selectedText) && selectedText.Equals(findText, comparison))
            {
                // Replace the selected text
                int selectionStart = _editor.SelectionStart;
                _editor.SelectedText = replaceText;
                _editor.SelectionStart = selectionStart;
                _editor.SelectionLength = replaceText.Length;
                
                Logger.Info($"Replaced text at position {selectionStart}");
            }
            
            // Find next occurrence
            FindText(forward: true);
        }
        catch (Exception ex)
        {
            Logger.Error("Error during replace operation", ex);
            MessageBox.Show($"Error during replace: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
    
    private void OnReplaceAll(object sender, RoutedEventArgs e)
    {
        try
        {
            var findText = FindTextBox.Text;
            var replaceText = ReplaceTextBox.Text;
            
            if (string.IsNullOrEmpty(findText))
            {
                MessageBox.Show("Please enter text to find.", "Replace All", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }
            
            if (string.IsNullOrEmpty(_editor.Text))
            {
                MessageBox.Show("No text to search.", "Replace All", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }
            
            var document = _editor.Document;
            var editorText = document.Text;
            
            var matchCase = MatchCaseCheckBox.IsChecked == true;
            var wholeWord = WholeWordCheckBox.IsChecked == true;
            var comparison = matchCase ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;
            
            // Find all instances first
            var replacements = new System.Collections.Generic.List<int>();
            int searchIndex = 0;
            
            while (searchIndex < editorText.Length)
            {
                int foundIndex = editorText.IndexOf(findText, searchIndex, comparison);
                
                if (foundIndex == -1)
                    break;
                
                // Check whole word if needed
                if (wholeWord && !IsWholeWord(editorText, foundIndex, findText.Length))
                {
                    searchIndex = foundIndex + 1;
                    continue;
                }
                
                replacements.Add(foundIndex);
                searchIndex = foundIndex + findText.Length;
            }
            
            if (replacements.Count > 0)
            {
                // Group undo actions
                document.BeginUpdate();
                try
                {
                    // Replace backwards to keep offsets valid
                    for (int i = replacements.Count - 1; i >= 0; i--)
                    {
                        document.Replace(replacements[i], findText.Length, replaceText);
                    }
                }
                finally
                {
                    document.EndUpdate();
                }
                
                MessageBox.Show($"Replaced {replacements.Count} occurrence(s).", "Replace All", MessageBoxButton.OK, MessageBoxImage.Information);
                Logger.Info($"Replaced {replacements.Count} occurrences");
            }
            else
            {
                MessageBox.Show($"Cannot find \"{findText}\"", "Replace All", MessageBoxButton.OK, MessageBoxImage.Information);
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Error during replace all operation", ex);
            MessageBox.Show($"Error during replace all: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
    
    private void FindText(bool forward)
    {
        try
        {
            var searchText = FindTextBox.Text;
            if (string.IsNullOrEmpty(searchText))
            {
                return;
            }
            
            var editorText = _editor.Text;
            if (string.IsNullOrEmpty(editorText))
            {
                MessageBox.Show("No text to search.", "Find", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }
            
            var matchCase = MatchCaseCheckBox.IsChecked == true;
            var wholeWord = WholeWordCheckBox.IsChecked == true;
            
            var comparison = matchCase ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;
            
            int startIndex;
            if (forward)
            {
                startIndex = _editor.SelectionStart + _editor.SelectionLength;
                if (startIndex >= editorText.Length)
                {
                    startIndex = 0;
                }
            }
            else
            {
                startIndex = _editor.SelectionStart - 1;
                if (startIndex < 0)
                {
                    startIndex = editorText.Length - 1;
                }
            }
            
            int foundIndex = -1;
            
            if (forward)
            {
                foundIndex = editorText.IndexOf(searchText, startIndex, comparison);
                
                if (foundIndex == -1 && startIndex > 0)
                {
                    foundIndex = editorText.IndexOf(searchText, 0, comparison);
                }
            }
            else
            {
                foundIndex = editorText.LastIndexOf(searchText, startIndex, comparison);
                
                if (foundIndex == -1 && startIndex < editorText.Length - 1)
                {
                    foundIndex = editorText.LastIndexOf(searchText, comparison);
                }
            }
            
            if (foundIndex != -1)
            {
                if (wholeWord)
                {
                    bool isWholeWord = IsWholeWord(editorText, foundIndex, searchText.Length);
                    if (!isWholeWord)
                    {
                        _editor.SelectionStart = forward ? foundIndex + 1 : foundIndex - 1;
                        _editor.SelectionLength = 0;
                        FindText(forward);
                        return;
                    }
                }
                
                _editor.SelectionStart = foundIndex;
                _editor.SelectionLength = searchText.Length;
                _editor.Focus();
                _editor.ScrollToLine(GetLineNumber(editorText, foundIndex));
                
                _lastSearchIndex = foundIndex;
                
                Logger.Info($"Found text at index {foundIndex}");
            }
            else
            {
                MessageBox.Show($"Cannot find \"{searchText}\"", "Find", MessageBoxButton.OK, MessageBoxImage.Information);
                _lastSearchIndex = 0;
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Error during find operation", ex);
            MessageBox.Show($"Error during search: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
    
    private bool IsWholeWord(string text, int index, int length)
    {
        if (index > 0)
        {
            char before = text[index - 1];
            if (char.IsLetterOrDigit(before) || before == '_')
            {
                return false;
            }
        }
        
        int endIndex = index + length;
        if (endIndex < text.Length)
        {
            char after = text[endIndex];
            if (char.IsLetterOrDigit(after) || after == '_')
            {
                return false;
            }
        }
        
        return true;
    }
    
    private int GetLineNumber(string text, int index)
    {
        int lineNumber = 0;
        for (int i = 0; i < index && i < text.Length; i++)
        {
            if (text[i] == '\n')
            {
                lineNumber++;
            }
        }
        return lineNumber;
    }
    
    private void OnClose(object sender, RoutedEventArgs e)
    {
        var owner = Owner;
        Owner = null;
        owner?.Activate();
        Close();
    }

    private void OnSearchTextChanged(object sender, TextChangedEventArgs e)
    {
        UpdateHighlights();
    }
    
    private void OnOptionChanged(object sender, RoutedEventArgs e)
    {
        UpdateHighlights();
    }
    
    private void UpdateHighlights()
    {
        try
        {
            if (_editor is DependencyObject depObj)
            {
                var mainWindow = Window.GetWindow(depObj) as MainWindow;
                if (mainWindow != null)
                {
                    mainWindow.UpdateSearchHighlights(FindTextBox.Text, MatchCaseCheckBox.IsChecked == true, WholeWordCheckBox.IsChecked == true);
                }
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to update highlights", ex);
        }
    }

    protected override void OnClosed(EventArgs e)
    {
        base.OnClosed(e);
        // Clear highlights
        try
        {
            if (_editor is DependencyObject depObj)
            {
                var mainWindow = Window.GetWindow(depObj) as MainWindow;
                if (mainWindow != null)
                {
                    mainWindow.UpdateSearchHighlights("", false, false);
                }
            }
        }
        catch { }
    }
}
