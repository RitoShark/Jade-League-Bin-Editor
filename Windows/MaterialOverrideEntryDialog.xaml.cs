using System;
using System.IO;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using Jade.Services;

namespace Jade.Windows;

public partial class MaterialOverrideEntryDialog : Window
{
    public string PathValue { get; private set; } = "";
    public string SubmeshValue { get; private set; } = "";
    public bool Accepted { get; private set; }
    
    public MaterialOverrideEntryDialog(string entryType, string defaultPath = "")
    {
        InitializeComponent();
        
        TitleTextBlock.Text = entryType == "texture" ? "Add Texture Entry" : "Add Material Entry";
        PathLabelTextBlock.Text = entryType == "texture" ? "Texture Path:" : "Material Path:";
        PathTextBox.Text = defaultPath;
        
        LoadAndApplyTheme();
        
        Loaded += (s, e) =>
        {
            PositionToLeft();
        };
    }
    
    private void OnAccept(object sender, RoutedEventArgs e)
    {
        PathValue = PathTextBox.Text.Trim();
        SubmeshValue = SubmeshTextBox.Text.Trim();
        
        if (string.IsNullOrEmpty(PathValue))
        {
            MessageBox.Show("Path cannot be empty", "Validation Error", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }
        
        if (string.IsNullOrEmpty(SubmeshValue))
        {
            MessageBox.Show("Submesh cannot be empty", "Validation Error", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }
        
        Accepted = true;
        Close();
    }
    
    private void OnCancel(object sender, RoutedEventArgs e)
    {
        Accepted = false;
        Close();
    }
    
    private void PositionToLeft()
    {
        try
        {
            if (Owner != null)
            {
                // Position to the left of the owner window
                Left = Owner.Left - ActualWidth - 10;
                Top = Owner.Top + 50;
                
                // Make sure it doesn't go off screen
                if (Left < 10) Left = 10;
                if (Top < 10) Top = 10;
                if (Top + ActualHeight > SystemParameters.PrimaryScreenHeight)
                    Top = SystemParameters.PrimaryScreenHeight - ActualHeight - 10;
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to position material override entry dialog", ex);
        }
    }
    
    private void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2)
        {
            return;
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
            Logger.Error("Failed to load theme for MaterialOverrideEntryDialog", ex);
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
            textColor = new SolidColorBrush(Color.FromRgb(30, 15, 25));
        }
        else if (theme == "PastelBlue")
        {
            bgColor = new SolidColorBrush(Color.FromRgb(210, 240, 255));
            titleBarBg = new SolidColorBrush(Color.FromRgb(255, 240, 250));
            textColor = new SolidColorBrush(Color.FromRgb(40, 25, 60));
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
        else
        {
            bgColor = new SolidColorBrush(Color.FromRgb(30, 30, 30));
            titleBarBg = new SolidColorBrush(Color.FromRgb(37, 37, 38));
            textColor = new SolidColorBrush(Color.FromRgb(212, 212, 212));
        }
        
        this.Background = bgColor;
        
        var titleBar = this.FindName("TitleBar") as System.Windows.Controls.Border;
        if (titleBar != null)
        {
            titleBar.Background = titleBarBg;
        }
        
        if (PathTextBox != null)
        {
            PathTextBox.Background = bgColor;
            PathTextBox.Foreground = textColor;
            PathTextBox.BorderBrush = new SolidColorBrush(Color.FromRgb(62, 62, 66));
        }
        
        if (SubmeshTextBox != null)
        {
            SubmeshTextBox.Background = bgColor;
            SubmeshTextBox.Foreground = textColor;
            SubmeshTextBox.BorderBrush = new SolidColorBrush(Color.FromRgb(62, 62, 66));
        }
        
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
}
