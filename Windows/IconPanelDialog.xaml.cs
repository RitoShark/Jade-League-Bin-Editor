using System;
using System.IO;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using Jade.Services;

namespace Jade.Windows;

public partial class IconPanelDialog : Window
{
    private readonly System.Windows.Controls.Primitives.ToggleButton _iconButton;
    private readonly MainWindow _mainWindow;
    private double _originalValue = 1.0;
    private bool _isUpdatingFromPercentage = false;
    
    public IconPanelDialog(System.Windows.Controls.Primitives.ToggleButton iconButton, MainWindow mainWindow)
    {
        InitializeComponent();
        _iconButton = iconButton;
        _mainWindow = mainWindow;
        
        LoadAndApplyTheme();
        
        Loaded += (s, e) =>
        {
            PositionUnderButton();
            LoadSkinscaleValue();
            CheckMaterialOverride();
        };
    }
    
    private void OnPercentageChanged(object sender, System.Windows.Controls.TextChangedEventArgs e)
    {
        if (_isUpdatingFromPercentage) return;
        
        try
        {
            var percentText = PercentageTextBox.Text.Trim();
            if (string.IsNullOrEmpty(percentText)) return;
            
            if (double.TryParse(percentText, out double percentage))
            {
                // Calculate new value based on percentage of original
                var newValue = _originalValue * (percentage / 100.0);
                
                _isUpdatingFromPercentage = true;
                SkinscaleTextBox.Text = newValue.ToString("F2");
                _isUpdatingFromPercentage = false;
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to calculate percentage", ex);
        }
    }
    
    private void LoadSkinscaleValue()
    {
        try
        {
            var editor = _mainWindow.GetCurrentEditor();
            if (editor == null)
            {
                StatusTextBlock.Text = "No file loaded";
                SkinscaleTextBox.IsEnabled = false;
                ApplySkinscaleButton.IsEnabled = false;
                return;
            }
            
            var text = editor.Text;
            var lines = text.Split('\n');
            
            foreach (var line in lines)
            {
                var trimmedLine = line.Trim();
                if (trimmedLine.StartsWith("skinScale:", StringComparison.OrdinalIgnoreCase) ||
                    trimmedLine.StartsWith("skinscale:", StringComparison.OrdinalIgnoreCase))
                {
                    // Extract the value after the colon
                    var parts = trimmedLine.Split(':');
                    if (parts.Length >= 2)
                    {
                        var valuepart = parts[1].Trim();
                        
                        // Extract just the number, removing "f32 = " or similar prefixes
                        if (valuepart.Contains('='))
                        {
                            var equalParts = valuepart.Split('=');
                            if (equalParts.Length >= 2)
                            {
                                valuepart = equalParts[1].Trim();
                            }
                        }
                        
                        SkinscaleTextBox.Text = valuepart;
                        
                        // Store original value for percentage calculations
                        if (double.TryParse(valuepart, out double parsedValue))
                        {
                            _originalValue = parsedValue;
                        }
                        
                        StatusTextBlock.Text = "Current value loaded";
                        Logger.Info($"Loaded skinscale value: {valuepart}");
                        return;
                    }
                }
            }
            
            StatusTextBlock.Text = "skinScale not found in file";
            Logger.Info("skinScale property not found in current file");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to load skinscale value", ex);
            StatusTextBlock.Text = "Error loading value";
        }
    }
    
    private void OnApplySkinscale(object sender, RoutedEventArgs e)
    {
        try
        {
            var editor = _mainWindow.GetCurrentEditor();
            if (editor == null)
            {
                StatusTextBlock.Text = "No file loaded";
                return;
            }
            
            var newValue = SkinscaleTextBox.Text.Trim();
            if (string.IsNullOrEmpty(newValue))
            {
                StatusTextBlock.Text = "Please enter a value";
                return;
            }
            
            var document = editor.Document;
            bool found = false;
            
            // Find the line containing skinScale
            for (int lineNum = 1; lineNum <= document.LineCount; lineNum++)
            {
                var line = document.GetLineByNumber(lineNum);
                var lineText = document.GetText(line.Offset, line.Length);
                var trimmedLine = lineText.Trim();
                
                if (trimmedLine.StartsWith("skinScale:", StringComparison.OrdinalIgnoreCase) ||
                    trimmedLine.StartsWith("skinscale:", StringComparison.OrdinalIgnoreCase))
                {
                    // Find the colon and check if there's an equals sign
                    var colonIndex = lineText.IndexOf(':');
                    var afterColon = lineText.Substring(colonIndex + 1).Trim();
                    
                    string newLineText;
                    if (afterColon.Contains('='))
                    {
                        // Format: skinScale: f32 = 1.15
                        var equalsIndex = lineText.IndexOf('=', colonIndex);
                        var beforeEquals = lineText.Substring(0, equalsIndex + 1);
                        newLineText = beforeEquals + " " + newValue;
                    }
                    else
                    {
                        // Format: skinScale: 1.15
                        var prefix = lineText.Substring(0, colonIndex + 1);
                        newLineText = prefix + " " + newValue;
                    }
                    
                    // Replace only this specific line
                    document.Replace(line.Offset, line.Length, newLineText);
                    
                    found = true;
                    StatusTextBlock.Text = $"Applied: {newValue}";
                    Logger.Info($"Updated skinscale to: {newValue}");
                    break;
                }
            }
            
            if (!found)
            {
                StatusTextBlock.Text = "skinScale not found";
                Logger.Info("Could not find skinScale property to update");
            }
            else
            {
                StatusTextBlock.Text = "skinScale not found";
                Logger.Info("Could not find skinScale property to update");
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to apply skinscale value", ex);
            StatusTextBlock.Text = "Error applying value";
        }
    }
    
    private void OnAddSkinscale(object sender, RoutedEventArgs e)
    {
        try
        {
            var editor = _mainWindow.GetCurrentEditor();
            if (editor == null)
            {
                StatusTextBlock.Text = "No file loaded";
                return;
            }
            
            var newValue = SkinscaleTextBox.Text.Trim();
            if (string.IsNullOrEmpty(newValue))
            {
                newValue = "1.0";
            }
            
            var document = editor.Document;
            bool found = false;
            
            // Look for the skinMeshProperties line
            for (int lineNum = 1; lineNum <= document.LineCount; lineNum++)
            {
                var line = document.GetLineByNumber(lineNum);
                var lineText = document.GetText(line.Offset, line.Length);
                
                if (lineText.Contains("skinMeshProperties:") && lineText.Contains("embed") && lineText.Contains("SkinMeshDataProperties"))
                {
                    // Get the indentation of the next line (or use default)
                    string indent = "        "; // Default indentation
                    if (lineNum + 1 <= document.LineCount)
                    {
                        var nextLine = document.GetLineByNumber(lineNum + 1);
                        var nextLineText = document.GetText(nextLine.Offset, nextLine.Length);
                        indent = nextLineText.Substring(0, nextLineText.Length - nextLineText.TrimStart().Length);
                    }
                    
                    // Insert the skinScale line right after this line (at the end of current line + newline)
                    var skinScaleLine = "\n" + indent + "skinScale: f32 = " + newValue;
                    var insertOffset = line.EndOffset;
                    
                    // Use Document.Insert to add the new line
                    document.Insert(insertOffset, skinScaleLine);
                    
                    StatusTextBlock.Text = $"Added skinScale: {newValue}";
                    Logger.Info($"Added skinScale property with value: {newValue}");
                    
                    // Reload to update the original value
                    LoadSkinscaleValue();
                    found = true;
                    break;
                }
            }
            
            if (!found)
            {
                StatusTextBlock.Text = "skinMeshProperties not found";
                Logger.Info("Could not find skinMeshProperties to insert skinScale");
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to add skinscale property", ex);
            StatusTextBlock.Text = "Error adding skinScale";
        }
    }
    
    private void PositionUnderButton()
    {
        try
        {
            if (Owner != null && _iconButton != null)
            {
                // Get button position relative to screen
                var buttonPosition = _iconButton.PointToScreen(new Point(0, 0));
                
                // Position dialog centered under the button, with padding from right edge
                var buttonCenterX = buttonPosition.X + (_iconButton.ActualWidth / 2);
                var dialogCenterX = ActualWidth / 2;
                Left = buttonCenterX - dialogCenterX;
                Top = buttonPosition.Y + _iconButton.ActualHeight + 5; // 5px gap
                
                // Make sure it doesn't go off screen or overlap scrollbar
                var screenWidth = SystemParameters.PrimaryScreenWidth;
                var screenHeight = SystemParameters.PrimaryScreenHeight;
                var scrollbarPadding = 30; // Extra padding to avoid scrollbar
                
                if (Left < 10) Left = 10;
                if (Top < 10) Top = 10;
                if (Left + ActualWidth > screenWidth - scrollbarPadding) 
                    Left = screenWidth - ActualWidth - scrollbarPadding;
                if (Top + ActualHeight > screenHeight) 
                    Top = screenHeight - ActualHeight - 10;
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to position icon panel dialog", ex);
        }
    }
    
    private void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2)
        {
            return; // No maximize for this dialog
        }
        else
        {
            DragMove();
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
            Logger.Error("Failed to load theme for IconPanelDialog", ex);
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
        SolidColorBrush bgColor, titleBarBg, textColor;
        
        if (theme == "DarkBlue")
        {
            bgColor = new SolidColorBrush(Color.FromRgb(20, 30, 45));
            titleBarBg = new SolidColorBrush(Color.FromRgb(25, 35, 50));
            textColor = new SolidColorBrush(Color.FromRgb(220, 230, 240));
        }
        else if (theme == "DarkRed")
        {
            bgColor = new SolidColorBrush(Color.FromRgb(45, 20, 25));
            titleBarBg = new SolidColorBrush(Color.FromRgb(50, 25, 30));
            textColor = new SolidColorBrush(Color.FromRgb(240, 220, 225));
        }
        else if (theme == "LightPink")
        {
            bgColor = new SolidColorBrush(Color.FromRgb(210, 165, 190));
            titleBarBg = new SolidColorBrush(Color.FromRgb(180, 130, 160));
            textColor = Brushes.Black;
        }
        else if (theme == "PastelBlue")
        {
            bgColor = new SolidColorBrush(Color.FromRgb(210, 240, 255));
            titleBarBg = new SolidColorBrush(Color.FromRgb(255, 240, 250));
            textColor = Brushes.Black;
        }
        else if (theme == "ForestGreen")
        {
            bgColor = new SolidColorBrush(Color.FromRgb(25, 45, 30));
            titleBarBg = new SolidColorBrush(Color.FromRgb(30, 50, 35));
            textColor = new SolidColorBrush(Color.FromRgb(200, 230, 210));
        }
        else if (theme == "AMOLED")
        {
            bgColor = new SolidColorBrush(Color.FromRgb(0, 0, 0));
            titleBarBg = new SolidColorBrush(Color.FromRgb(10, 10, 10));
            textColor = new SolidColorBrush(Color.FromRgb(180, 180, 180));
        }
        else if (theme == "Void")
        {
            bgColor = new SolidColorBrush(Color.FromRgb(15, 10, 30));
            titleBarBg = new SolidColorBrush(Color.FromRgb(20, 15, 40));
            textColor = new SolidColorBrush(Color.FromRgb(180, 170, 220));
        }
        else if (theme == "VioletSorrow")
        {
            bgColor = new SolidColorBrush(Color.FromRgb(22, 12, 42));
            titleBarBg = new SolidColorBrush(Color.FromRgb(32, 20, 58));
            textColor = new SolidColorBrush(Color.FromRgb(185, 170, 215));
        }
        else // Default
        {
            bgColor = new SolidColorBrush(Color.FromRgb(30, 30, 30));
            titleBarBg = new SolidColorBrush(Color.FromRgb(37, 37, 38));
            textColor = new SolidColorBrush(Color.FromRgb(212, 212, 212));
        }
        
        this.Background = bgColor;
        
        // Update title bar
        var titleBar = this.FindName("TitleBar") as System.Windows.Controls.Border;
        if (titleBar != null)
        {
            titleBar.Background = titleBarBg;
        }
        
        // Update TextBox theme
        if (SkinscaleTextBox != null)
        {
            SkinscaleTextBox.Background = bgColor;
            SkinscaleTextBox.Foreground = textColor;
            SkinscaleTextBox.BorderBrush = new SolidColorBrush(Color.FromRgb(62, 62, 66));
        }
        
        if (PercentageTextBox != null)
        {
            PercentageTextBox.Background = bgColor;
            PercentageTextBox.Foreground = textColor;
            PercentageTextBox.BorderBrush = new SolidColorBrush(Color.FromRgb(62, 62, 66));
        }
        
        // Update all TextBlocks
        UpdateTextBlockColors(this, textColor);
    }
    
    private void UpdateTextBlockColors(DependencyObject parent, SolidColorBrush color)
    {
        int childCount = VisualTreeHelper.GetChildrenCount(parent);
        for (int i = 0; i < childCount; i++)
        {
            var child = VisualTreeHelper.GetChild(parent, i);
            if (child is System.Windows.Controls.TextBlock textBlock)
            {
                textBlock.Foreground = color;
            }
            UpdateTextBlockColors(child, color);
        }
    }
    
    private void CheckMaterialOverride()
    {
        try
        {
            var editor = _mainWindow.GetCurrentEditor();
            if (editor == null)
            {
                MaterialStatusTextBlock.Text = "No file loaded";
                AddMaterialOverrideButton.IsEnabled = false;
                return;
            }
            
            var text = editor.Text;
            bool hasMaterialOverride = text.Contains("materialOverride:");
            
            if (hasMaterialOverride)
            {
                AddMaterialOverrideButton.Visibility = System.Windows.Visibility.Collapsed;
                MaterialOverrideOptionsPanel.Visibility = System.Windows.Visibility.Visible;
                MaterialStatusTextBlock.Text = "materialOverride detected";
            }
            else
            {
                AddMaterialOverrideButton.Visibility = System.Windows.Visibility.Visible;
                MaterialOverrideOptionsPanel.Visibility = System.Windows.Visibility.Collapsed;
                MaterialStatusTextBlock.Text = "materialOverride not found";
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to check material override", ex);
            MaterialStatusTextBlock.Text = "Error checking materialOverride";
        }
    }
    
    private void OnAddMaterialOverride(object sender, RoutedEventArgs e)
    {
        try
        {
            var editor = _mainWindow.GetCurrentEditor();
            if (editor == null)
            {
                MaterialStatusTextBlock.Text = "No file loaded";
                return;
            }
            
            var document = editor.Document;
            bool found = false;
            
            // Look for skinMeshProperties line
            for (int lineNum = 1; lineNum <= document.LineCount; lineNum++)
            {
                var line = document.GetLineByNumber(lineNum);
                var lineText = document.GetText(line.Offset, line.Length);
                
                if (lineText.Contains("skinMeshProperties:") && lineText.Contains("embed") && lineText.Contains("SkinMeshDataProperties"))
                {
                    // Get indentation
                    string indent = "        ";
                    if (lineNum + 1 <= document.LineCount)
                    {
                        var nextLine = document.GetLineByNumber(lineNum + 1);
                        var nextLineText = document.GetText(nextLine.Offset, nextLine.Length);
                        indent = nextLineText.Substring(0, nextLineText.Length - nextLineText.TrimStart().Length);
                    }
                    
                    // Create materialOverride structure
                    var materialOverrideText = "\n" + indent + "materialOverride: list[embed] = {\n" + indent + "}";
                    var insertOffset = line.EndOffset;
                    
                    // Use Document.Insert to add the new lines
                    document.Insert(insertOffset, materialOverrideText);
                    
                    MaterialStatusTextBlock.Text = "materialOverride added";
                    Logger.Info("Added materialOverride structure");
                    
                    CheckMaterialOverride();
                    found = true;
                    break;
                }
            }
            
            if (!found)
            {
                MaterialStatusTextBlock.Text = "skinMeshProperties not found";
                Logger.Info("Could not find skinMeshProperties to insert materialOverride");
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to add materialOverride", ex);
            MaterialStatusTextBlock.Text = "Error adding materialOverride";
        }
    }
    
    private string ExtractTexturePath()
    {
        try
        {
            var editor = _mainWindow.GetCurrentEditor();
            if (editor == null) return "";
            
            var text = editor.Text;
            var lines = text.Split('\n');
            
            foreach (var line in lines)
            {
                var trimmedLine = line.Trim();
                if (trimmedLine.StartsWith("texture:", StringComparison.OrdinalIgnoreCase))
                {
                    // Extract the path between quotes
                    var parts = trimmedLine.Split('=');
                    if (parts.Length >= 2)
                    {
                        var pathPart = parts[1].Trim();
                        // Remove quotes
                        pathPart = pathPart.Trim('"', ' ');
                        return pathPart;
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to extract texture path", ex);
        }
        
        return "";
    }
    
    private void OnAddTexture(object sender, RoutedEventArgs e)
    {
        try
        {
            var defaultPath = ExtractTexturePath();
            var dialog = new MaterialOverrideEntryDialog("texture", defaultPath)
            {
                Owner = this
            };
            
            dialog.ShowDialog();
            
            if (dialog.Accepted)
            {
                AddMaterialOverrideEntry(dialog.PathValue, dialog.SubmeshValue, "texture");
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to add texture entry", ex);
            MaterialStatusTextBlock.Text = "Error adding texture";
        }
    }
    
    private void OnAddMaterial(object sender, RoutedEventArgs e)
    {
        try
        {
            var defaultPath = ExtractTexturePath();
            var dialog = new MaterialOverrideEntryDialog("material", defaultPath)
            {
                Owner = this
            };
            
            dialog.ShowDialog();
            
            if (dialog.Accepted)
            {
                AddMaterialOverrideEntry(dialog.PathValue, dialog.SubmeshValue, "material");
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to add material entry", ex);
            MaterialStatusTextBlock.Text = "Error adding material";
        }
    }
    
    private void AddMaterialOverrideEntry(string path, string submesh, string entryType)
    {
        try
        {
            var editor = _mainWindow.GetCurrentEditor();
            if (editor == null)
            {
                MaterialStatusTextBlock.Text = "No file loaded";
                return;
            }
            
            var document = editor.Document;
            bool found = false;
            
            // Find the materialOverride closing brace
            for (int lineNum = 1; lineNum <= document.LineCount; lineNum++)
            {
                var line = document.GetLineByNumber(lineNum);
                var lineText = document.GetText(line.Offset, line.Length);
                
                if (lineText.Contains("materialOverride:") && lineText.Contains("list[embed]"))
                {
                    // Find the closing brace of materialOverride by tracking brace depth
                    int braceDepth = 0;
                    int insertLineNum = -1;
                    
                    for (int j = lineNum; j <= document.LineCount; j++)
                    {
                        var currentLine = document.GetLineByNumber(j);
                        var currentLineText = document.GetText(currentLine.Offset, currentLine.Length);
                        
                        // Count opening braces
                        foreach (char c in currentLineText)
                        {
                            if (c == '{') braceDepth++;
                            else if (c == '}') braceDepth--;
                        }
                        
                        // When we get back to depth 0, we found the closing brace of materialOverride
                        if (braceDepth == 0 && j > lineNum)
                        {
                            insertLineNum = j;
                            break;
                        }
                    }
                    
                    if (insertLineNum != -1)
                    {
                        // Get indentation from the line after materialOverride declaration
                        string indent = "            ";
                        if (lineNum + 1 <= document.LineCount)
                        {
                            var nextLine = document.GetLineByNumber(lineNum + 1);
                            var nextLineText = document.GetText(nextLine.Offset, nextLine.Length);
                            if (!string.IsNullOrWhiteSpace(nextLineText))
                            {
                                indent = nextLineText.Substring(0, nextLineText.Length - nextLineText.TrimStart().Length);
                            }
                        }
                        
                        // Create the entry text
                        // texture uses "string" type, material uses "link" type
                        string propertyType = entryType == "texture" ? "string" : "link";
                        var entryText = indent + "SkinMeshDataProperties_MaterialOverride {\n" +
                                       indent + "    " + (entryType == "texture" ? "texture" : "material") + ": " + propertyType + " = \"" + path + "\"\n" +
                                       indent + "    submesh: string = \"" + submesh + "\"\n" +
                                       indent + "}\n";
                        
                        // Insert before the closing brace line
                        var insertLine = document.GetLineByNumber(insertLineNum);
                        document.Insert(insertLine.Offset, entryText);
                        
                        MaterialStatusTextBlock.Text = $"Added {entryType} entry";
                        Logger.Info($"Added {entryType} override entry: {path} -> {submesh}");
                        
                        found = true;
                    }
                    
                    break;
                }
            }
            
            if (!found)
            {
                MaterialStatusTextBlock.Text = "materialOverride structure not found";
                Logger.Info("Could not find materialOverride structure");
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to add material override entry", ex);
            MaterialStatusTextBlock.Text = "Error adding entry";
        }
    }
}
