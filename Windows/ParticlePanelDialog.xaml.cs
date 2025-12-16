using System;
using System.IO;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using Jade.Services;

namespace Jade.Windows;

public partial class ParticlePanelDialog : Window
{
    private readonly System.Windows.Controls.Primitives.ToggleButton _iconButton;
    private readonly MainWindow _mainWindow;
    
    public ParticlePanelDialog(System.Windows.Controls.Primitives.ToggleButton iconButton, MainWindow mainWindow)
    {
        InitializeComponent();
        _iconButton = iconButton;
        _mainWindow = mainWindow;
        
        LoadAndApplyTheme();
        
        Loaded += (s, e) =>
        {
            PositionUnderButton();
        };
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
            Logger.Error("Failed to position particle panel dialog", ex);
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
            Logger.Error("Failed to load theme for ParticlePanelDialog", ex);
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
}
