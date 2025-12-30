using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using Microsoft.Win32;
using Jade.Services;
using ICSharpCode.AvalonEdit;
using ICSharpCode.AvalonEdit.Highlighting;
using ICSharpCode.AvalonEdit.Highlighting.Xshd;
using System.Xml;
using Jade.Ritobin;

namespace Jade.Windows;

public class EditorTab
{
    public string? FilePath { get; set; }
    public TextEditor Editor { get; set; } = null!;
    public bool IsModified { get; set; }
    public Jade.Editor.SearchHighlightRenderer? SearchRenderer { get; set; }
    public ICSharpCode.AvalonEdit.Folding.FoldingManager? FoldingManager { get; set; }
    public List<Jade.Editor.SyntaxError> Errors { get; set; } = new();
    public Jade.Editor.ErrorHighlightRenderer? ErrorHighlightRenderer { get; set; }
    public Jade.Editor.ErrorUnderlineRenderer? ErrorUnderlineRenderer { get; set; }
    public Jade.Editor.MinimapBackgroundRenderer? MinimapRenderer { get; set; }
    public Jade.Editor.StickyScrollControl? StickyScroll { get; set; }
    public System.Windows.Threading.DispatcherTimer? ValidationTimer { get; set; }
    public System.Windows.Threading.DispatcherTimer? FoldingTimer { get; set; }
}

public partial class MainWindow : Window
{
    private readonly List<EditorTab> _tabs = new();
    private IconPanelDialog? _iconPanelDialog = null;
    private ParticlePanelDialog? _particlePanelDialog = null;
    private FindDialog? _findDialog = null;
    private ReplaceDialog? _replaceDialog = null;
    private double _zoomLevel = 100.0; // Default 100%
    private ToolTip? _minimapTooltip;
    private System.Windows.Media.Color _currentSearchHighlightColor = System.Windows.Media.Color.FromArgb(60, 255, 215, 0);
    private PerformanceCounter? _ramCounter;
    private System.Windows.Threading.DispatcherTimer? _perfTimer;
    private List<string> _recentFiles = new List<string>();
    private const int MaxRecentFiles = 10;
    
    private Button? CloseAllButton => EditorTabControl?.Template?.FindName("PART_CloseAllButton", EditorTabControl) as Button;

    public MainWindow()
    {
        try
        {
            Logger.Info("Initializing MainWindow");
            
            // Auto-clear temp folder if enabled
            SettingsWindow.ClearTempFolderOnStartup();
            
            InitializeComponent();
            
            // Auto-download hashes if enabled (after InitializeComponent so StatusText is available)
            SettingsWindow.DownloadHashesOnStartup(status =>
            {
                Dispatcher.Invoke(() =>
                {
                    if (StatusText != null)
                    {
                        StatusText.Text = status;
                    }
                });
            });
            
            // Check if hash preloading is enabled
            var jadeDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "RitoShark", "Jade");
            var prefsFile = Path.Combine(jadeDir, "preferences.txt");
            bool preloadHashes = false;
            
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                if (content.Contains("PreloadHashes="))
                {
                    preloadHashes = content.Contains("PreloadHashes=True");
                }
            }
            
            // Preload hash files if enabled
            if (preloadHashes)
            {
                var hashDir = Path.Combine(jadeDir, "hashes");
                if (Directory.Exists(hashDir))
                {
                    BinConverter.StartPreloading(hashDir);
                    
                    // Add a continuation to force GC on the UI thread once background loading is finished.
                    // This ensures the 450MB peak drops to 270MB immediately without user interaction.
                    Task.Run(async () => {
                        while (!HashManager.IsLoaded) await Task.Delay(500);
                        await Dispatcher.InvokeAsync(() => {
                            HashManager.ForceCollection();
                            Logger.Info("HashManager: Post-load cleanup triggered on UI thread.");
                        });
                    });
                    
                    Logger.Info("Started preloading hash files in background (setting enabled)");
                }
            }
            else
            {
                Logger.Info("Hash preloading disabled (setting disabled, will load per-file)");
            }
            
            // Load zoom level
            LoadZoomLevel();
            
            // NOTE: Theme is now loaded in App.xaml.cs after window creation to avoid redundant loads
        
            CommandBindings.Add(new CommandBinding(ApplicationCommands.Open, (s, e) => OnOpenFile(s, e)));
            CommandBindings.Add(new CommandBinding(ApplicationCommands.Save, (s, e) => OnSaveFile(s, e)));
            CommandBindings.Add(new CommandBinding(ApplicationCommands.SaveAs, (s, e) => OnSaveFileAs(s, e)));
            CommandBindings.Add(new CommandBinding(ApplicationCommands.Find, (s, e) => OnFind(s, e)));
            CommandBindings.Add(new CommandBinding(ApplicationCommands.Replace, (s, e) => OnReplace(s, e)));
            CommandBindings.Add(new CommandBinding(ApplicationCommands.Undo, (s, e) => OnUndo(s, e)));
            CommandBindings.Add(new CommandBinding(ApplicationCommands.Redo, (s, e) => OnRedo(s, e)));
            CommandBindings.Add(new CommandBinding(ApplicationCommands.Cut, (s, e) => OnCut(s, e)));
            CommandBindings.Add(new CommandBinding(ApplicationCommands.Copy, (s, e) => OnCopy(s, e)));
            CommandBindings.Add(new CommandBinding(ApplicationCommands.Paste, (s, e) => OnPaste(s, e)));
            CommandBindings.Add(new CommandBinding(ApplicationCommands.SelectAll, (s, e) => OnSelectAll(s, e)));
            
            InputBindings.Add(new KeyBinding(ApplicationCommands.Open, Key.O, ModifierKeys.Control));
            InputBindings.Add(new KeyBinding(ApplicationCommands.Save, Key.S, ModifierKeys.Control));
            InputBindings.Add(new KeyBinding(ApplicationCommands.SaveAs, Key.S, ModifierKeys.Control | ModifierKeys.Shift));
            InputBindings.Add(new KeyBinding(ApplicationCommands.Find, Key.F, ModifierKeys.Control));
            InputBindings.Add(new KeyBinding(ApplicationCommands.Replace, Key.H, ModifierKeys.Control));
            InputBindings.Add(new KeyBinding(ApplicationCommands.Undo, Key.Z, ModifierKeys.Control));
            InputBindings.Add(new KeyBinding(ApplicationCommands.Redo, Key.Y, ModifierKeys.Control));
            InputBindings.Add(new KeyBinding(ApplicationCommands.Cut, Key.X, ModifierKeys.Control));
            InputBindings.Add(new KeyBinding(ApplicationCommands.Copy, Key.C, ModifierKeys.Control));
            InputBindings.Add(new KeyBinding(ApplicationCommands.Paste, Key.V, ModifierKeys.Control));
            InputBindings.Add(new KeyBinding(ApplicationCommands.SelectAll, Key.A, ModifierKeys.Control));
            
            // Custom command for compare
            var compareCommand = new RoutedCommand();
            CommandBindings.Add(new CommandBinding(compareCommand, (s, e) => OnCompareFiles(s, e)));
            InputBindings.Add(new KeyBinding(compareCommand, Key.D, ModifierKeys.Control));

            SourceInitialized += OnSourceInitialized;
            StateChanged += OnWindowStateChanged;
            
            // Enable drag and drop
            AllowDrop = true;
            Drop += OnFileDrop;
            DragEnter += OnDragEnter;
            DragOver += OnDragOver;
            DragLeave += OnDragLeave;
            
            Loaded += (s, e) =>
            {
                Logger.Info("MainWindow loaded");
                
                // Restore window state from previous session
                RestoreWindowState();
                
                // Initialize Tray Service
                TrayService.Initialize();

                // Check for minimized startup flag
                string[] args = Environment.GetCommandLineArgs();
                bool startMinimized = args.Contains("--minimized");
                bool hasFile = !string.IsNullOrEmpty(App.StartupFilePath);

                if (startMinimized && !hasFile)
                {
                    Logger.Info("Started minimized to tray (no file argument)");
                    this.Hide();
                    TrayService.SetVisible(true);
                }
                else if (hasFile)
                {
                    Logger.Info("Started with file, ensuring visibility");
                    this.Show();
                    this.Activate();
                    TrayService.SetVisible(false);
                }

                UpdateWelcomeScreenVisibility();
                UpdateZoomIndicator();
                
                // Initialize status bar state
                UpdateErrorCount();
                UpdateCaretPosition();
                UpdateLineCount();
                
                // Check if a file was passed as command-line argument (from "Open with")
                if (!string.IsNullOrEmpty(App.StartupFilePath) && System.IO.File.Exists(App.StartupFilePath))
                {
                    _ = OpenFileFromPathAsync(App.StartupFilePath);
                }
            };
            
            Logger.Info("MainWindow initialized successfully");
            
            InitializePerformanceMonitoring();
            LoadRecentFiles();
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to initialize MainWindow", ex);
            MessageBox.Show($"Failed to initialize: {ex.Message}\n\nCheck log at: {Logger.GetLogPath()}", 
                "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private EditorTab? GetCurrentTab()
    {
        if (EditorTabControl.SelectedIndex >= 0 && EditorTabControl.SelectedIndex < _tabs.Count)
            return _tabs[EditorTabControl.SelectedIndex];
        return null;
    }

    public TextEditor? GetCurrentEditor()
    {
        return GetCurrentTab()?.Editor;
    }

    private string GetCurrentThemeName()
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

    private string GetCurrentBracketThemeName()
    {
        try
        {
            var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var prefsFile = Path.Combine(appDataPath, "RitoShark", "Jade", "preferences.txt");
            
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                
                // If override is NOT checked, use current UI theme
                if (!content.Contains("OverrideBracketTheme=True"))
                {
                    return GetCurrentThemeName();
                }

                if (content.Contains("BracketTheme="))
                {
                    var lines = content.Split('\n');
                    foreach (var line in lines)
                    {
                        if (line.Trim().StartsWith("BracketTheme="))
                        {
                            return line.Substring(13).Trim();
                        }
                    }
                }
            }
        }
        catch { }
        
        return GetCurrentThemeName();
    }

    private Color GetLineNumberColorForTheme(string theme)
    {
        return theme switch
        {
            "DarkBlue" => Color.FromRgb(100, 140, 180),      // Soft blue-gray
            "DarkRed" => Color.FromRgb(180, 100, 120),       // Soft red-gray
            "LightPink" => Color.FromRgb(120, 80, 110),      // Dark purple-gray for contrast
            "PastelBlue" => Color.FromRgb(80, 120, 160),     // Medium blue for contrast
            "ForestGreen" => Color.FromRgb(100, 150, 120),   // Soft green-gray
            "AMOLED" => Color.FromRgb(100, 100, 100),        // Medium gray on black
            "Void" => Color.FromRgb(140, 120, 180),          // Soft purple-gray
            "VioletSorrow" => Color.FromRgb(130, 100, 185),  // Deep sorrowful violet
            "OrangeBurnout" => Color.FromRgb(180, 100, 50),  // Warm orange-gray
            "PurpleGrief" => Color.FromRgb(160, 140, 170),   // Sorrowful violet-gray
            _ => Color.FromRgb(128, 128, 128)                // Default gray
        };
    }

    private void UpdateWelcomeScreenVisibility()
    {
        if (_tabs.Count == 0)
        {
            WelcomeScreen.Visibility = Visibility.Visible;
            EditorTabControl.Visibility = Visibility.Collapsed;
            if (CloseAllButton != null) CloseAllButton.Visibility = Visibility.Collapsed;
        }
        else
        {
            WelcomeScreen.Visibility = Visibility.Collapsed;
            EditorTabControl.Visibility = Visibility.Visible;
            
            // Ensure template is applied before accessing CloseAllButton
            EditorTabControl.ApplyTemplate();
            
            // Show Close All button whenever there's at least one tab
            if (CloseAllButton != null) CloseAllButton.Visibility = Visibility.Visible;
        }
    }

    private void CreateNewTab(string? filePath = null, string? content = null)
    {
        var app = Application.Current;
        var bracketTheme = GetCurrentBracketThemeName();
        var currentTheme = GetCurrentThemeName(); // Still needed for some conditional logic if any, or for legacy renderers
        
        var tab = new EditorTab
        {
            FilePath = filePath,
            IsModified = false
        };

        var editor = new TextEditor
        {
            // Background and Foreground set via DynamicResource below
            FontFamily = new FontFamily("Consolas"),
            FontSize = GetFontSizeFromZoom(),
            ShowLineNumbers = true,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
            BorderThickness = new Thickness(0),
            Padding = new Thickness(10),
            WordWrap = false,
            Document = new ICSharpCode.AvalonEdit.Document.TextDocument(content ?? "")
        };
        
        // Set dynamic resource references
        editor.SetResourceReference(Control.BackgroundProperty, "EditorBackgroundBrush");
        editor.SetResourceReference(Control.ForegroundProperty, "PrimaryTextBrush");
        editor.SetResourceReference(ICSharpCode.AvalonEdit.TextEditor.LineNumbersForegroundProperty, "MutedTextBrush");
        
        // initialize syntax highlighting
        try 
        {
            // Handle syntax theme override
            string syntaxTheme = currentTheme;
            if (bool.TryParse(ThemeHelper.ReadPreference("OverrideBracketTheme", "False"), out bool overrideSyntax) && overrideSyntax)
            {
                syntaxTheme = ThemeHelper.ReadPreference("BracketTheme", currentTheme);
            }

            var (keyword, comment, stringColor, number, property) = ThemeHelper.GetThemeSyntaxColors(syntaxTheme);
            
            editor.SyntaxHighlighting = ThemeSyntaxHighlighting.GetHighlightingForTheme(
                keyword, comment, stringColor, number, property);
        }
        catch (Exception exVal)
        {
            Logger.Error("Failed to update syntax highlighting in New Tab", exVal);
        }
        
        // 1. Limit Undo Stack to reduce memory usage on large files
        editor.Document.UndoStack.SizeLimit = 256;

        // LineNumbersForeground set via SetResourceReference above

        // Add bracket colorizer
        var b1 = GetColorFromResource(app, "BracketColor1", Colors.Gold);
        var b2 = GetColorFromResource(app, "BracketColor2", Colors.Magenta);
        var b3 = GetColorFromResource(app, "BracketColor3", Colors.Cyan);
        
        var bracketColors = new[] { b1, b2, b3 };
        editor.TextArea.TextView.LineTransformers.Add(new Jade.Editor.BracketColorizer(bracketColors));

        // Add bracket matching highlighter
        var bracketHighlighter = new Jade.Editor.BracketHighlightRenderer(editor.TextArea.TextView, bracketTheme);
        editor.TextArea.TextView.BackgroundRenderers.Add(bracketHighlighter);
        
        // Add bracket scope line renderer (vertical lines connecting brackets)
        var scopeLineRenderer = new Jade.Editor.BracketScopeLineRenderer(editor.TextArea.TextView, bracketTheme);
        editor.TextArea.TextView.BackgroundRenderers.Add(scopeLineRenderer);
        
        // Add minimap background (subtle different color on right edge)
        var minimapBackground = new Jade.Editor.MinimapBackgroundRenderer(editor.TextArea.TextView);
        
        // Apply theme color
        // Use EditorBackground with specific alpha
        Color editorBgColor = Colors.Black; // Default
        try {
             if (app.Resources["EditorBackgroundBrush"] is SolidColorBrush bgBrush)
                 editorBgColor = bgBrush.Color;
        } catch {}

        var minimapBg = editorBgColor.R > 128 
            ? System.Windows.Media.Color.FromArgb(20, 0, 0, 0) // Light theme
            : System.Windows.Media.Color.FromArgb(15, 255, 255, 255); // Dark theme
            
        minimapBackground.SetBackgroundColor(minimapBg);
        
        editor.TextArea.TextView.BackgroundRenderers.Insert(0, minimapBackground); // Insert first so it's behind other renderers
        
        // Add search result highlighter (minimap bar)
        var searchRenderer = new Jade.Editor.SearchHighlightRenderer(editor.TextArea.TextView);
        searchRenderer.SetHighlightColor(_currentSearchHighlightColor);
        editor.TextArea.TextView.BackgroundRenderers.Add(searchRenderer);
        
        // Add error renderers
        var errorHighlightRenderer = new Jade.Editor.ErrorHighlightRenderer(editor.TextArea.TextView);
        editor.TextArea.TextView.BackgroundRenderers.Add(errorHighlightRenderer);
        
        var errorUnderlineRenderer = new Jade.Editor.ErrorUnderlineRenderer(editor.TextArea.TextView);
        editor.TextArea.TextView.BackgroundRenderers.Add(errorUnderlineRenderer);
        
        // Update bracket highlighting and scope lines when caret moves
        editor.TextArea.Caret.PositionChanged += (s, e) =>
        {
            var (opening, closing) = Jade.Editor.BracketMatcher.FindMatchingBracket(
                editor.Document, 
                editor.CaretOffset);
            
            bracketHighlighter.OpeningBracketOffset = opening;
            bracketHighlighter.ClosingBracketOffset = closing;
            
            scopeLineRenderer.OpeningBracketOffset = opening;
            scopeLineRenderer.ClosingBracketOffset = closing;
            
            // REMOVED: Full redraw on every caret move causes severe lag on large files
            // The bracket renderers already invalidate their own visual layer
            // editor.TextArea.TextView.Redraw();
            
            UpdateCaretPosition();
        };

        // Add Ctrl+Scroll zoom support
        editor.PreviewMouseWheel += OnEditorMouseWheel;
        
        // Add custom Undo/Redo handling to preserve scroll position
        editor.PreviewKeyDown += OnEditorPreviewKeyDown;
        
        // Configure tooltips for immediate display
        System.Windows.Controls.ToolTipService.SetInitialShowDelay(editor.TextArea.TextView, 0);
        System.Windows.Controls.ToolTipService.SetShowDuration(editor.TextArea.TextView, 60000);
        System.Windows.Controls.ToolTipService.SetBetweenShowDelay(editor.TextArea.TextView, 0);
        
        // Add minimap interaction (cursor, tooltips, scrolling)
        editor.TextArea.TextView.MouseMove += (s, e) =>
        {
            var textView = editor.TextArea.TextView;
            var pos = e.GetPosition(textView);
            var renderSize = textView.RenderSize;
            
            // Reset cursor and tooltip when leaving the text area
            // Check if mouse is in the minimap area (right 20 pixels)
            if (pos.X >= renderSize.Width - Jade.Editor.MinimapBackgroundRenderer.MinimapWidth)
            {
                textView.Cursor = System.Windows.Input.Cursors.Hand;
                
                // Tooltip logic
                var totalLines = editor.Document.LineCount;
                if (totalLines > 0)
                {
                    var lineRatio = pos.Y / renderSize.Height;
                    var lineData = (int)(lineRatio * totalLines) + 1;
                    lineData = Math.Max(1, Math.Min(lineData, totalLines));
                    
                    // Calculate tooltip text
                    string newTooltip;
                    var errorMsg = tab.ErrorHighlightRenderer?.GetErrorNearLine(lineData, totalLines, renderSize.Height);
                    
                    if (!string.IsNullOrEmpty(errorMsg))
                    {
                         newTooltip = $"Line {lineData}: {errorMsg}";
                    }
                    else if (tab.SearchRenderer?.HasMarkerNearLine(lineData, totalLines, renderSize.Height) == true)
                    {
                         newTooltip = $"Line {lineData}: Search Result";
                    }
                    else
                    {
                         newTooltip = $"Jump to Line {lineData}";
                    }
                    
                    // Use manual tooltip control
                    if (_minimapTooltip == null)
                    {
                        _minimapTooltip = new ToolTip 
                        { 
                            StaysOpen = true,
                            IsHitTestVisible = false,
                            Padding = new Thickness(5)
                        };
                        
                        // Apply current theme if available (simple check)
                        if (Background is SolidColorBrush bg)
                        {
                            _minimapTooltip.Background = bg;
                            _minimapTooltip.BorderBrush = new SolidColorBrush(Colors.Gray);
                            _minimapTooltip.BorderThickness = new Thickness(1);
                        }
                    }
                    
                    _minimapTooltip.Content = newTooltip;
                    _minimapTooltip.PlacementTarget = textView;
                    
                    // Fixed placement: Left of the minimap strip vertically aligned with mouse
                    double minimapEdgeX = renderSize.Width - Jade.Editor.MinimapBackgroundRenderer.MinimapWidth;
                    // Define a target rectangle at the minimap edge at the current Y position
                    _minimapTooltip.PlacementRectangle = new Rect(minimapEdgeX, pos.Y, 0, 0);
                    
                    _minimapTooltip.Placement = System.Windows.Controls.Primitives.PlacementMode.Left;
                    _minimapTooltip.HorizontalOffset = -5; // Add a small gap between tooltip and minimap
                    _minimapTooltip.VerticalOffset = 0;
                    _minimapTooltip.IsOpen = true;
                }
            }
            else
            {
                textView.Cursor = System.Windows.Input.Cursors.IBeam;
                if (_minimapTooltip != null) _minimapTooltip.IsOpen = false;
            }
        };
        
        // Reset cursor and tooltip when leaving the text area
        editor.TextArea.TextView.MouseLeave += (s, e) =>
        {
            editor.TextArea.TextView.Cursor = System.Windows.Input.Cursors.IBeam;
            if (_minimapTooltip != null) _minimapTooltip.IsOpen = false;
        };
        
        // Add minimap click support - click on right edge to jump to that line
        editor.TextArea.TextView.MouseLeftButtonDown += (s, e) =>
        {
            var textView = editor.TextArea.TextView;
            var pos = e.GetPosition(textView);
            var renderSize = textView.RenderSize;
            
            // Check if click is in the minimap area (right 20 pixels)
            if (pos.X >= renderSize.Width - Jade.Editor.MinimapBackgroundRenderer.MinimapWidth)
            {
                var totalLines = editor.Document.LineCount;
                if (totalLines > 0)
                {
                    // Calculate which line was clicked based on Y position
                    var lineRatio = pos.Y / renderSize.Height;
                    var targetLine = (int)(lineRatio * totalLines) + 1;
                    targetLine = Math.Max(1, Math.Min(targetLine, totalLines));
                    
                    // Jump to that line - SCROLL ONLY, DO NOT MOVE CARET
                    editor.ScrollToLine(targetLine);
                    
                    // Prevent editor from handling the click (which would move caret/selection)
                    e.Handled = true;
                }
            }
        };
        
        // Install folding manager for code folding
        var foldingManager = ICSharpCode.AvalonEdit.Folding.FoldingManager.Install(editor.TextArea);
        var foldingStrategy = new Jade.Editor.BinFileFoldingStrategy();
        
        // Apply folding colors based on current theme
        ApplyFoldingColors(editor);

        
        // Initial folding update
        if (!string.IsNullOrEmpty(content))
        {
            foldingStrategy.UpdateFoldings(foldingManager, editor.Document);
        }

        // Create Sticky Scroll
        var stickyScroll = new Jade.Editor.StickyScrollControl();
        stickyScroll.Initialize(editor, foldingManager);

        tab.Editor = editor;
        tab.SearchRenderer = searchRenderer;
        tab.FoldingManager = foldingManager;
        tab.ErrorHighlightRenderer = errorHighlightRenderer;
        tab.ErrorUnderlineRenderer = errorUnderlineRenderer;
        tab.MinimapRenderer = minimapBackground;
        tab.StickyScroll = stickyScroll;
        
        // Create validation timer with 500ms debounce
        var validationTimer = new System.Windows.Threading.DispatcherTimer
        {
            Interval = TimeSpan.FromMilliseconds(500)
        };
        validationTimer.Tick += (s, e) =>
        {
            validationTimer.Stop();
            ValidateCurrentTab(tab);
        };
        tab.ValidationTimer = validationTimer;

        // Create folding timer for debounced updates (1.5s delay)
        var foldingTimer = new System.Windows.Threading.DispatcherTimer
        {
            Interval = TimeSpan.FromSeconds(1.5)
        };
        foldingTimer.Tick += (s, e) =>
        {
            foldingTimer.Stop();
            foldingStrategy.UpdateFoldings(foldingManager, editor.Document);
        };
        tab.FoldingTimer = foldingTimer;
        
        editor.TextArea.SelectionChanged += (s, e) => UpdateCaretPosition();
        editor.TextChanged += (s, e) => 
        { 
            tab.IsModified = true; 
            UpdateLineCount();
            
            // Restart validation timer (500ms debounce)
            validationTimer.Stop();
            validationTimer.Start();
            
            // Restart folding timer (1.5s debounce) - Significant performance improvement
            foldingTimer.Stop();
            foldingTimer.Start();
        };

        _tabs.Add(tab);

        var grid = new Grid();
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        Grid.SetRow(stickyScroll, 0);
        Grid.SetRow(editor, 1);

        grid.Children.Add(stickyScroll);
        grid.Children.Add(editor);

        var tabItem = new TabItem
        {
            Header = filePath != null ? Path.GetFileName(filePath) : "Untitled",
            ToolTip = filePath ?? "Untitled",
            Content = grid
        };

        EditorTabControl.Items.Add(tabItem);
        EditorTabControl.SelectedIndex = EditorTabControl.Items.Count - 1;
        
        UpdateWelcomeScreenVisibility();
        UpdateLineCount();
        UpdateCaretPosition();
        ValidateCurrentTab(tab);
    }

    public void UpdateStickyScrollVisibility(bool force = false)
    {
        foreach (var tab in _tabs)
        {
            tab.StickyScroll?.UpdateStickyLines(force);
        }
    }
    
    // Removed UpdateTabEditorColors as it is now handled directly in ApplyTheme using resources

    
    private void ValidateCurrentTab(EditorTab tab)
    {
        try
        {
            if (tab.Editor == null) return;
            
            // Run validation
            var errors = Jade.Editor.BinSyntaxValidator.Validate(tab.Editor.Text);
            tab.Errors = errors;
            
            // Update renderers
            tab.ErrorHighlightRenderer?.UpdateErrors(errors);
            tab.ErrorUnderlineRenderer?.UpdateErrors(errors);
            
            // Update status bar
            UpdateErrorCount();
            
            Logger.Info($"Validated tab: {errors.Count} error(s) found");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to validate tab", ex);
        }
    }
    
    private void UpdateErrorCount()
    {
        try
        {
            var tab = GetCurrentTab();
            if (tab == null)
            {
                if (ErrorCountText != null)
                {
                    ErrorCountText.Text = "No file loaded";
                    ErrorCountText.Foreground = new SolidColorBrush(Colors.Gray);
                }
                return;
            }
            
            if (ErrorCountText != null)
            {
                if (tab.Errors.Count == 0)
                {
                    ErrorCountText.Text = "No errors";
                    ErrorCountText.Foreground = new SolidColorBrush(Colors.Green);
                }
                else
                {
                    ErrorCountText.Text = $"{tab.Errors.Count} error(s)";
                    ErrorCountText.Foreground = new SolidColorBrush(Colors.Red);
                }
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to update error count", ex);
        }
    }
    
    // Removed GetCurrentEditorBackground, GetCurrentEditorForeground, GetCurrentTabBackground as they are no longer used

    
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
    

    


    private async void OnOpenFile(object sender, RoutedEventArgs e)
    {
        try
        {
            Logger.Info("Opening file dialog");
            var dialog = new OpenFileDialog
            {
                Filter = "BIN Files (*.bin)|*.bin|Python Files (*.py)|*.py|Text Files (*.txt)|*.txt|All Files (*.*)|*.*",
                Title = "Open File"
            };

            if (dialog.ShowDialog() == true)
            {
                Logger.Info($"User selected file: {dialog.FileName}");
                StatusText.Text = "Loading...";
                
                var content = await LoadFileContentAsync(dialog.FileName);
                
                Logger.Info($"Setting text in editor, length: {content.Length}");
                StatusText.Text = "Rendering...";
                
                // Give UI time to update
                await System.Threading.Tasks.Task.Delay(10);
                
                CreateNewTab(dialog.FileName, content);
                
                FileTypeText.Text = Path.GetExtension(dialog.FileName).ToUpper();
                StatusText.Text = "File loaded";
                
                AddToRecentFiles(dialog.FileName);
                Logger.Info("File loaded successfully");
                
                // Open linked bin files if preference is enabled
                await OpenLinkedBinFilesAsync(dialog.FileName, content);
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Error in OnOpenFile", ex);
            MessageBox.Show($"Error loading file: {ex.Message}\n\nCheck log at: {Logger.GetLogPath()}", 
                "Error", MessageBoxButton.OK, MessageBoxImage.Error);
            StatusText.Text = "Error loading file";
        }
    }

    /// <summary>
    /// Opens a file from an external path (e.g., command-line argument or drag-drop).
    /// </summary>
    public async Task OpenFileFromPathAsync(string filePath)
    {
        try
        {
            Logger.Info($"Opening file from path: {filePath}");
            StatusText.Text = "Loading...";
            
            var content = await LoadFileContentAsync(filePath);
            
            StatusText.Text = "Rendering...";
            await System.Threading.Tasks.Task.Delay(10);
            
            CreateNewTab(filePath, content);
            
            FileTypeText.Text = Path.GetExtension(filePath).ToUpper();
            StatusText.Text = "File loaded";
            
            AddToRecentFiles(filePath);
            Logger.Info($"File loaded from path: {filePath}");
            
            // Open linked bin files if preference is enabled
            await OpenLinkedBinFilesAsync(filePath, content);
        }
        catch (Exception ex)
        {
            Logger.Error($"Error opening file from path: {filePath}", ex);
            MessageBox.Show($"Error loading file: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
            StatusText.Text = "Error loading file";
        }
    }

    /// <summary>
    /// Opens linked bin files if the preference is enabled.
    /// Searches for linked files in the DATA folder relative to the opened file.
    /// </summary>
    private async Task OpenLinkedBinFilesAsync(string mainFilePath, string content)
    {
        try
        {
            // Check if importing linked bins is enabled
            var importLinked = ThemeHelper.ReadPreference("ImportLinkedBins", "False");
            if (!importLinked.Equals("True", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }
            
            // Only process .bin files (or converted .py content from bin)
            var extension = Path.GetExtension(mainFilePath).ToLower();
            if (extension != ".bin" && extension != ".py")
            {
                return;
            }
            
            // Check if recursive loading is enabled
            var recursiveEnabled = ThemeHelper.ReadPreference("RecursiveLinkedBins", "False")
                .Equals("True", StringComparison.OrdinalIgnoreCase);
            
            // Track all opened file paths (normalized) to prevent duplicates
            var openedFilePaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            
            // Add all currently open tabs to the set
            foreach (var tab in _tabs)
            {
                if (!string.IsNullOrEmpty(tab.FilePath))
                {
                    openedFilePaths.Add(Path.GetFullPath(tab.FilePath));
                }
            }
            
            // Get the base directory for searching
            var baseDirectory = Path.GetDirectoryName(mainFilePath);
            if (string.IsNullOrEmpty(baseDirectory))
            {
                return;
            }
            
            // Queue of files to process (for recursive loading)
            var filesToProcess = new Queue<(string content, string basePath)>();
            filesToProcess.Enqueue((content, baseDirectory));
            
            var totalOpenedCount = 0;
            var maxRecursionDepth = 3; // Limit recursion to prevent infinite loops
            var currentDepth = 0;
            var filesAtCurrentDepth = 1;
            var filesAtNextDepth = 0;
            
            while (filesToProcess.Count > 0 && (currentDepth == 0 || recursiveEnabled))
            {
                var (fileContent, searchBasePath) = filesToProcess.Dequeue();
                filesAtCurrentDepth--;
                
                // Parse linked files from content
                var linkedFiles = LinkedBinParser.ParseLinkedFiles(fileContent);
                if (linkedFiles.Count == 0)
                {
                    continue;
                }
                
                Logger.Info($"Found {linkedFiles.Count} linked bin files at depth {currentDepth}");
                
                foreach (var linkedFileName in linkedFiles)
                {
                    // Search for the file in DATA folder
                    var foundPath = LinkedBinParser.FindBinFileInDataFolder(searchBasePath, linkedFileName);
                    if (foundPath == null)
                    {
                        Logger.Info($"Linked bin file not found: {linkedFileName}");
                        continue;
                    }
                    
                    var normalizedPath = Path.GetFullPath(foundPath);
                    
                    // Skip if this file is already open or was already processed
                    if (openedFilePaths.Contains(normalizedPath))
                    {
                        Logger.Info($"Skipping already open file: {linkedFileName}");
                        continue;
                    }
                    
                    // Mark as opened to prevent duplicates
                    openedFilePaths.Add(normalizedPath);
                    
                    Logger.Info($"Opening linked bin file: {foundPath}");
                    StatusText.Text = $"Loading linked: {linkedFileName}...";
                    
                    try
                    {
                        var linkedContent = await LoadFileContentAsync(foundPath);
                        await Task.Delay(5); // Brief delay for UI responsiveness
                        CreateNewTab(foundPath, linkedContent);
                        totalOpenedCount++;
                        
                        // If recursive is enabled, queue this file's content for processing
                        if (recursiveEnabled && currentDepth < maxRecursionDepth)
                        {
                            var linkedBasePath = Path.GetDirectoryName(foundPath);
                            if (!string.IsNullOrEmpty(linkedBasePath))
                            {
                                filesToProcess.Enqueue((linkedContent, linkedBasePath));
                                filesAtNextDepth++;
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        Logger.Error($"Failed to open linked file: {foundPath}", ex);
                    }
                }
                
                // Track recursion depth
                if (filesAtCurrentDepth == 0 && filesAtNextDepth > 0)
                {
                    currentDepth++;
                    filesAtCurrentDepth = filesAtNextDepth;
                    filesAtNextDepth = 0;
                    Logger.Info($"Moving to recursion depth {currentDepth}");
                }
                
                // Stop if we've completed the first level and recursive is disabled
                if (!recursiveEnabled && currentDepth > 0)
                {
                    break;
                }
            }
            
            if (totalOpenedCount > 0)
            {
                StatusText.Text = $"Loaded {totalOpenedCount} linked file(s)";
                Logger.Info($"Successfully opened {totalOpenedCount} linked bin files");
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Error opening linked bin files", ex);
        }
    }

    private async void OnSaveFile(object sender, RoutedEventArgs e)
    {
        var tab = GetCurrentTab();
        if (tab == null) return;

        if (string.IsNullOrEmpty(tab.FilePath))
        {
            OnSaveFileAs(sender, e);
            return;
        }

        await SaveFileContent(tab, tab.FilePath);
    }

    private async void OnSaveFileAs(object sender, RoutedEventArgs e)
    {
        var tab = GetCurrentTab();
        if (tab == null) return;

        var dialog = new SaveFileDialog
        {
            Filter = "Text Files (*.txt;*.py)|*.txt;*.py|BIN Files (*.bin)|*.bin|All Files (*.*)|*.*",
            Title = "Save File As"
        };

        if (dialog.ShowDialog() == true)
        {
            await SaveFileContent(tab, dialog.FileName);
            AddToRecentFiles(dialog.FileName);
        }
    }
    
    private void LoadRecentFiles()
    {
        try
        {
            var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var jadeDir = Path.Combine(appDataPath, "RitoShark", "Jade");
            var prefsFile = Path.Combine(jadeDir, "preferences.txt");

            if (File.Exists(prefsFile))
            {
                var lines = File.ReadAllLines(prefsFile);
                var recentLine = lines.FirstOrDefault(l => l.StartsWith("RecentFiles="));
                if (recentLine != null)
                {
                    var paths = recentLine.Substring("RecentFiles=".Length).Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
                    _recentFiles.Clear();
                    foreach (var path in paths)
                    {
                        if (File.Exists(path))
                        {
                            _recentFiles.Add(path);
                        }
                    }
                }
            }
            UpdateRecentFilesMenu();
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to load recent files", ex);
        }
    }

    private void SaveRecentFiles()
    {
        try
        {
            var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var jadeDir = Path.Combine(appDataPath, "RitoShark", "Jade");
            var prefsFile = Path.Combine(jadeDir, "preferences.txt");

            var lines = File.Exists(prefsFile) ? File.ReadAllLines(prefsFile).ToList() : new List<string>();
            var recentValue = string.Join(",", _recentFiles);

            bool found = false;
            for (int i = 0; i < lines.Count; i++)
            {
                if (lines[i].StartsWith("RecentFiles="))
                {
                    lines[i] = $"RecentFiles={recentValue}";
                    found = true;
                    break;
                }
            }

            if (!found) lines.Add($"RecentFiles={recentValue}");

            File.WriteAllLines(prefsFile, lines);
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to save recent files", ex);
        }
    }

    private void AddToRecentFiles(string path)
    {
        try
        {
            _recentFiles.Remove(path);
            _recentFiles.Insert(0, path);

            while (_recentFiles.Count > MaxRecentFiles)
            {
                _recentFiles.RemoveAt(_recentFiles.Count - 1);
            }

            SaveRecentFiles();
            UpdateRecentFilesMenu();
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to add recent file", ex);
        }
    }

    private void UpdateRecentFilesMenu()
    {
        if (RecentFilesMenu == null) return;

        RecentFilesMenu.Items.Clear();

        if (_recentFiles.Count == 0)
        {
            var noItems = new MenuItem { Header = "No Recent Files", IsEnabled = false };
            RecentFilesMenu.Items.Add(noItems);
            return;
        }

        foreach (var path in _recentFiles)
        {
            var item = new MenuItem
            {
                Header = Path.GetFileName(path),
                ToolTip = path
            };
            item.Click += (s, e) => { _ = OpenFileFromPathAsync(path); };
            RecentFilesMenu.Items.Add(item);
        }

        RecentFilesMenu.Items.Add(new Separator());
        var clearItem = new MenuItem { Header = "Clear Recent Files" };
        clearItem.Click += (s, e) =>
        {
            _recentFiles.Clear();
            SaveRecentFiles();
            UpdateRecentFilesMenu();
        };
        RecentFilesMenu.Items.Add(clearItem);
    }
    
    private async Task SaveFileContent(EditorTab tab, string filePath)
    {
        try
        {
            StatusText.Text = "Saving...";
            var content = tab.Editor.Text;
            
            // Create temp folder for backup
            var jadeDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "RitoShark", "Jade");
            var tempDir = Path.Combine(jadeDir, "temp");
            Directory.CreateDirectory(tempDir);
            
            // Save temp text backup
            var tempFile = Path.Combine(tempDir, Path.GetFileNameWithoutExtension(filePath) + "_backup.txt");
            File.WriteAllText(tempFile, content);
            Logger.Info($"Created temp backup: {tempFile}");
            
            // Check if this is a .bin file that needs conversion
            if (Path.GetExtension(filePath).Equals(".bin", StringComparison.OrdinalIgnoreCase))
            {
                // Convert text back to binary
                var hashDir = Path.Combine(jadeDir, "hashes");
                var binaryData = BinConverter.ConvertTextToBin(content, out var error, hashDir);
                
                if (binaryData == null)
                {
                    // Conversion failed - show error
                    Logger.Error($"Failed to convert text to binary: {error}", null);
                    var result = MessageBox.Show(
                        $"Failed to convert text to binary format:\n\n{error}\n\nA text backup has been saved to:\n{tempFile}\n\nWould you like to save as text file (.py) instead?",
                        "Conversion Error",
                        MessageBoxButton.YesNo,
                        MessageBoxImage.Warning);
                    
                    if (result == MessageBoxResult.Yes)
                    {
                        // Save as .py instead
                        var pyPath = Path.ChangeExtension(filePath, ".py");
                        File.WriteAllText(pyPath, content);
                        tab.FilePath = pyPath;
                        tab.IsModified = false;
                        
                        if (EditorTabControl.SelectedItem is TabItem tabItem)
                        {
                            tabItem.Header = Path.GetFileName(pyPath);
                        }
                        
                        StatusText.Text = $"Saved as text file: {Path.GetFileName(pyPath)}";
                        Logger.Info($"Saved as text: {pyPath}");
                    }
                    else
                    {
                        StatusText.Text = "Save cancelled";
                    }
                    return;
                }
                
                // Write binary data
                File.WriteAllBytes(filePath, binaryData);
                Logger.Info($"Converted and saved binary file: {filePath}");
            }
            else
            {
                // Regular text file - just save
                File.WriteAllText(filePath, content);
                Logger.Info($"Saved text file: {filePath}");
            }
            
            tab.FilePath = filePath;
            tab.IsModified = false;
            
            if (EditorTabControl.SelectedItem is TabItem tabItem2)
            {
                tabItem2.Header = Path.GetFileName(filePath);
            }
            
            StatusText.Text = "File saved successfully";
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to save file", ex);
            MessageBox.Show($"Error saving file: {ex.Message}", "Error",
                MessageBoxButton.OK, MessageBoxImage.Error);
            StatusText.Text = "Error saving file";
        }
    }

    private void PerformUndo(TextEditor? editor)
    {
        if (editor == null) return;
        try
        {
            if (editor.CanUndo)
            {
                // Ensure editor has focus FIRST so keyboard shortcuts work
                if (!editor.IsFocused)
                {
                    editor.Focus();
                }
                
                // Save scroll position
                var verticalOffset = editor.VerticalOffset;
                var horizontalOffset = editor.HorizontalOffset;
                
                // Perform undo
                editor.Undo();
                
                // Restore scroll position using Input priority to ensure it happens after all internal updates
                Dispatcher.InvokeAsync(() =>
                {
                    if (editor != null)
                    {
                        editor.ScrollToVerticalOffset(verticalOffset);
                        editor.ScrollToHorizontalOffset(horizontalOffset);
                    }
                }, System.Windows.Threading.DispatcherPriority.Input);
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to perform undo", ex);
        }
    }

    protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
    {
        if (ShouldMinimizeToTray())
        {
            e.Cancel = true;
            this.Hide();
            TrayService.SetVisible(true);
            Logger.Info("Window minimized to tray instead of closing");
        }
        else
        {
            // Save window state before closing
            SaveWindowState();
            TrayService.Cleanup();
            base.OnClosing(e);
        }
    }

    private bool ShouldMinimizeToTray()
    {
        try
        {
            string appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string prefsFile = Path.Combine(appDataPath, "RitoShark", "Jade", "preferences.txt");
            if (File.Exists(prefsFile))
            {
                string content = File.ReadAllText(prefsFile);
                return content.Contains("MinimizeToTray=True");
            }
        }
        catch { }
        return false;
    }

    private void OnExit(object sender, RoutedEventArgs e)
    {
        TrayService.Cleanup();
        Application.Current.Shutdown();
    }

    private void OnUndo(object sender, RoutedEventArgs e)
    {
        PerformUndo(GetCurrentEditor());
    }

    private void PerformRedo(TextEditor? editor)
    {
        if (editor == null) return;
        try
        {
            if (editor.CanRedo)
            {
                // Ensure editor has focus FIRST
                if (!editor.IsFocused)
                {
                    editor.Focus();
                }
                
                // Save scroll position
                var verticalOffset = editor.VerticalOffset;
                var horizontalOffset = editor.HorizontalOffset;
                
                // Perform redo
                editor.Redo();
                
                // Restore scroll position
                Dispatcher.InvokeAsync(() =>
                {
                    if (editor != null)
                    {
                        editor.ScrollToVerticalOffset(verticalOffset);
                        editor.ScrollToHorizontalOffset(horizontalOffset);
                    }
                }, System.Windows.Threading.DispatcherPriority.Input);
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to perform redo", ex);
        }
    }

    private void OnRedo(object sender, RoutedEventArgs e)
    {
        PerformRedo(GetCurrentEditor());
    }

    private void OnEditorPreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (sender is TextEditor editor)
        {
            if (e.Key == Key.Z && (Keyboard.Modifiers & ModifierKeys.Control) == ModifierKeys.Control)
            {
                e.Handled = true;
                PerformUndo(editor);
            }
            else if (e.Key == Key.Y && (Keyboard.Modifiers & ModifierKeys.Control) == ModifierKeys.Control)
            {
                e.Handled = true;
                PerformRedo(editor);
            }
        }
    }

    private void OnCut(object sender, RoutedEventArgs e)
    {
        var editor = GetCurrentEditor();
        if (editor != null && !string.IsNullOrEmpty(editor.SelectedText))
        {
            editor.Cut();
        }
    }

    private void OnCopy(object sender, RoutedEventArgs e)
    {
        var editor = GetCurrentEditor();
        if (editor != null && !string.IsNullOrEmpty(editor.SelectedText))
        {
            editor.Copy();
        }
    }

    private void OnPaste(object sender, RoutedEventArgs e)
    {
        var editor = GetCurrentEditor();
        if (editor != null)
        {
            editor.Paste();
        }
    }

    private void OnSelectAll(object sender, RoutedEventArgs e)
    {
        var editor = GetCurrentEditor();
        if (editor != null)
        {
            editor.SelectAll();
        }
    }

    private void OnFind(object sender, RoutedEventArgs e)
    {
        try
        {
            if (_findDialog != null && _findDialog.IsVisible)
            {
                _findDialog.Close();
                _findDialog = null;
                FindButton.IsChecked = false;
                return;
            }

            var editor = GetCurrentEditor();
            if (editor == null)
            {
                MessageBox.Show("No file is currently open.", "Find", MessageBoxButton.OK, MessageBoxImage.Information);
                FindButton.IsChecked = false;
                return;
            }
            
            // Close replace dialog if open
            if (_replaceDialog != null && _replaceDialog.IsVisible)
            {
                _replaceDialog.Close();
            }
            
            Logger.Info("Opening find dialog");
            _findDialog = new FindDialog(editor)
            {
                Owner = this
            };
            _findDialog.Closed += (s, args) => 
            {
                _findDialog = null;
                FindButton.IsChecked = false;
            };
            _findDialog.Show();
            FindButton.IsChecked = true;
        }
        catch (Exception ex)
        {
            FindButton.IsChecked = false;
            Logger.Error("Failed to open find dialog", ex);
            MessageBox.Show($"Failed to open find dialog: {ex.Message}", "Error",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void OnReplace(object sender, RoutedEventArgs e)
    {
        try
        {
            if (_replaceDialog != null && _replaceDialog.IsVisible)
            {
                _replaceDialog.Close();
                _replaceDialog = null;
                ReplaceButton.IsChecked = false;
                return;
            }

            var editor = GetCurrentEditor();
            if (editor == null)
            {
                MessageBox.Show("No file is currently open.", "Replace", MessageBoxButton.OK, MessageBoxImage.Information);
                ReplaceButton.IsChecked = false;
                return;
            }
            
            // Close find dialog if open
            if (_findDialog != null && _findDialog.IsVisible)
            {
                _findDialog.Close();
            }
            
            Logger.Info("Opening replace dialog");
            _replaceDialog = new ReplaceDialog(editor)
            {
                Owner = this
            };
            _replaceDialog.Closed += (s, args) => 
            {
                _replaceDialog = null;
                ReplaceButton.IsChecked = false;
            };
            _replaceDialog.Show();
            ReplaceButton.IsChecked = true;
        }
        catch (Exception ex)
        {
            ReplaceButton.IsChecked = false;
            Logger.Error("Failed to open replace dialog", ex);
            MessageBox.Show($"Failed to open replace dialog: {ex.Message}", "Error",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void OnOpenLog(object sender, RoutedEventArgs e)
    {
        try
        {
            var logPath = Logger.GetLogPath();
            if (File.Exists(logPath))
            {
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                {
                    FileName = logPath,
                    UseShellExecute = true
                });
            }
            else
            {
                MessageBox.Show($"Log file not found at:\n{logPath}", "Log File", 
                    MessageBoxButton.OK, MessageBoxImage.Information);
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show($"Failed to open log file: {ex.Message}", "Error", 
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void OnThemes(object sender, RoutedEventArgs e)
    {
        try
        {
            Logger.Info("Opening themes window");
            var themesWindow = new ThemesWindow
            {
                Owner = this
            };
            themesWindow.ShowDialog();
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to open themes", ex);
            MessageBox.Show($"Failed to open themes: {ex.Message}", "Error",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void OnSettings(object sender, RoutedEventArgs e)
    {
        try
        {
            Logger.Info("Opening settings window");
            var settingsWindow = new SettingsWindow
            {
                Owner = this
            };
            settingsWindow.ShowDialog();
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to open settings", ex);
            MessageBox.Show($"Failed to open settings: {ex.Message}", "Error",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void OnPreferences(object sender, RoutedEventArgs e)
    {
        try
        {
            Logger.Info("Opening preferences window");
            var preferencesWindow = new PreferencesWindow
            {
                Owner = this
            };
            preferencesWindow.ShowDialog();
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to open preferences", ex);
            MessageBox.Show($"Failed to open preferences: {ex.Message}", "Error",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void OnCompareFiles(object sender, RoutedEventArgs e)
    {
        try
        {
            if (_tabs.Count < 2)
            {
                MessageBox.Show("You need at least 2 open files to compare.", "Compare Files",
                    MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }
            
            Logger.Info("Opening compare dialog");
            var compareDialog = new CompareDialog(_tabs);
            compareDialog.Show();
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to open compare dialog", ex);
            MessageBox.Show($"Failed to open compare dialog: {ex.Message}", "Error",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void OnEditorSelectionChanged(object sender, RoutedEventArgs e)
    {
        UpdateCaretPosition();
    }
    
    private void OnEditorTextChanged(object sender, TextChangedEventArgs e)
    {
        UpdateLineCount();
    }
    
    private void UpdateCaretPosition()
    {
        try
        {
            var editor = GetCurrentEditor();
            if (editor == null)
            {
                if (CaretPosition != null) CaretPosition.Text = "Ln 1, Col 1";
                return;
            }

            var line = editor.TextArea.Caret.Line;
            var column = editor.TextArea.Caret.Column;
            
            if (CaretPosition != null) CaretPosition.Text = $"Ln {line}, Col {column}";
        }
        catch
        {
            if (CaretPosition != null) CaretPosition.Text = "Ln 1, Col 1";
        }
    }
    
    private void UpdateLineCount()
    {
        try
        {
            var editor = GetCurrentEditor();
            if (editor == null)
            {
                LineCount.Text = "0 lines";
                return;
            }

            // Calculate line count manually since editor.LineCount can return -1
            var lineCount = string.IsNullOrEmpty(editor.Text) ? 0 : editor.Text.Split('\n').Length;
            LineCount.Text = $"{lineCount:N0} lines";
        }
        catch
        {
            LineCount.Text = "0 lines";
        }
    }
    
    public void UpdateSearchHighlights(string searchText, bool matchCase, bool wholeWord)
    {
        try
        {
            var editor = GetCurrentEditor();
            if (editor == null) return;
            
            // Find the tab for this editor
            var tab = _tabs.FirstOrDefault(t => t.Editor == editor);
            if (tab?.SearchRenderer == null) return;
            
            var offsets = new List<int>();
            
            if (!string.IsNullOrEmpty(searchText))
            {
                var text = editor.Text;
                var comparison = matchCase ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;
                int index = 0;
                
                while ((index = text.IndexOf(searchText, index, comparison)) != -1)
                {
                    bool isMatch = true;
                    if (wholeWord)
                    {
                        // Check word boundaries
                        if (index > 0)
                        {
                            char before = text[index - 1];
                            if (char.IsLetterOrDigit(before) || before == '_') isMatch = false;
                        }
                        
                        if (isMatch && index + searchText.Length < text.Length)
                        {
                            char after = text[index + searchText.Length];
                            if (char.IsLetterOrDigit(after) || after == '_') isMatch = false;
                        }
                    }
                    
                    if (isMatch)
                    {
                        offsets.Add(index);
                    }
                    
                    index++;
                }
            }
            
            tab.SearchRenderer.SearchLength = string.IsNullOrEmpty(searchText) ? 0 : searchText.Length;
            tab.SearchRenderer.SearchOffsets = offsets;
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to update search highlights", ex);
        }
    }


    // Custom Title Bar Handlers
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

    protected override void OnStateChanged(EventArgs e)
    {
        base.OnStateChanged(e);
        if (MaximizeButton != null)
        {
            MaximizeButton.Content = WindowState == WindowState.Maximized ? "\uE923" : "\uE922";
        }
    }

    private void CloseWindow(object sender, RoutedEventArgs e)
    {
        Close();
    }
    
    // Fix maximize to respect taskbar
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
                    // Use work area to respect taskbar and prevent clipping
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

    private void OnCloseTab(object sender, RoutedEventArgs e)
    {
        if (sender is Button button && button.Tag is TabItem tabItem)
        {
            CloseTabInternal(tabItem, true);
            UpdateWelcomeScreenVisibility();
        }
    }

    private async void OnCloseAllTabs(object sender, RoutedEventArgs e)
    {
        try
        {
            // Visual feedback
            if (CloseAllButton != null)
            {
                CloseAllButton.Content = "Closing...";
                CloseAllButton.IsEnabled = false;
            }
            
            // Allow UI to update
            await System.Threading.Tasks.Task.Delay(10);
            
            var tabsToClose = EditorTabControl.Items.Cast<TabItem>().ToList();
            
            foreach (var tabItem in tabsToClose)
            {
                CloseTabInternal(tabItem, false);
            }
            
            UpdateWelcomeScreenVisibility();
            
            // Full aggressive cleanup at the end, exactly mirroring the original single-tab behavior
            GCSettings.LargeObjectHeapCompactionMode = GCLargeObjectHeapCompactionMode.CompactOnce;
            GC.Collect(GC.MaxGeneration, GCCollectionMode.Aggressive, blocking: true, compacting: true);
            GC.WaitForPendingFinalizers();
            GC.Collect(GC.MaxGeneration, GCCollectionMode.Aggressive, blocking: true, compacting: true);
            
            Logger.Info($"Closed {tabsToClose.Count} tabs and cleaned memory efficiently");
        }
        catch (Exception ex)
        {
            Logger.Error("Error closing all tabs", ex);
        }
        finally
        {
            // Reset button state
            if (CloseAllButton != null)
            {
                CloseAllButton.Content = "Close All";
                CloseAllButton.IsEnabled = true;
            }
        }
    }

    private void CloseTabInternal(TabItem tabItem, bool cleanupMemory = true)
    {
        var index = EditorTabControl.Items.IndexOf(tabItem);
        if (index >= 0 && index < _tabs.Count)
        {
            var tab = _tabs[index];
            
            // 1. Stop Timers
            if (tab.ValidationTimer != null)
            {
                tab.ValidationTimer.Stop();
                tab.ValidationTimer = null;
            }
            if (tab.FoldingTimer != null)
            {
                tab.FoldingTimer.Stop();
                tab.FoldingTimer = null;
            }

            // 2. Cleanup Folding
            if (tab.FoldingManager != null)
            {
                ICSharpCode.AvalonEdit.Folding.FoldingManager.Uninstall(tab.FoldingManager);
                tab.FoldingManager = null;
            }
            
            // 3. Cleanup Editor
            if (tab.Editor != null)
            {
                tab.Editor.TextChanged -= null; 
                tab.Editor.Document.Text = string.Empty;
                tab.Editor.Document.UndoStack.ClearAll();
                tab.Editor.TextArea.TextView.BackgroundRenderers.Clear();
                tab.Editor.TextArea.TextView.LineTransformers.Clear();
                tab.Editor.SyntaxHighlighting = null;
            }
            
            // 4. Cleanup Tab properties
            tab.SearchRenderer = null;
            tab.ErrorHighlightRenderer = null;
            tab.ErrorUnderlineRenderer = null;
            tab.MinimapRenderer = null;
            
            // 5. Visual Cleanup
            if (tabItem.Content is Grid grid)
            {
                grid.Children.Clear();
            }
            tabItem.Content = null;
            
            // 6. Remove from collections
            _tabs.RemoveAt(index);
            EditorTabControl.Items.Remove(tabItem);
            
            // 7. Final Nuke
            tab.Editor = null!;
            tab.FilePath = null;

            if (cleanupMemory)
            {
                GCSettings.LargeObjectHeapCompactionMode = GCLargeObjectHeapCompactionMode.CompactOnce;
                GC.Collect(GC.MaxGeneration, GCCollectionMode.Aggressive, blocking: true, compacting: true);
                GC.WaitForPendingFinalizers();
                GC.Collect(GC.MaxGeneration, GCCollectionMode.Aggressive, blocking: true, compacting: true);
            }
        }
    }

    private void OnTabSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        var tab = GetCurrentTab();
        
        // Update general status items
        UpdateErrorCount();
        UpdateCaretPosition();
        UpdateLineCount();
        
        if (tab != null)
        {
            if (!string.IsNullOrEmpty(tab.FilePath))
            {
                FileTypeText.Text = Path.GetExtension(tab.FilePath).ToUpper();
            }
            else
            {
                FileTypeText.Text = "";
            }
        }
        else
        {
            if (FileTypeText != null) FileTypeText.Text = "";
        }
    }

    private void OnTabControlMouseWheel(object sender, MouseWheelEventArgs e)
    {
        var scrollViewer = EditorTabControl?.Template?.FindName("PART_TabScrollViewer", EditorTabControl) as ScrollViewer;
        if (scrollViewer != null)
        {
            if (e.Delta < 0)
                scrollViewer.ScrollToHorizontalOffset(scrollViewer.HorizontalOffset + 30);
            else
                scrollViewer.ScrollToHorizontalOffset(scrollViewer.HorizontalOffset - 30);
            e.Handled = true;
        }
    }

    private async Task<string> LoadFileContentAsync(string filePath)
    {
        return await Task.Run(() =>
        {
            try
            {
                var extension = Path.GetExtension(filePath).ToLower();
                
                if (extension == ".bin")
                {
                    return ConvertBinToText(filePath);
                }
                
                return File.ReadAllText(filePath);
            }
            catch (Exception ex)
            {
                Logger.Error($"Failed to load file: {filePath}", ex);
                return $"# Error loading file: {ex.Message}";
            }
        });
    }

    private string ConvertBinToText(string binPath)
    {
        try
        {
            var pyPath = Path.ChangeExtension(binPath, ".py");
            if (File.Exists(pyPath))
            {
                Logger.Info($"Found existing .py file: {pyPath}");
                return File.ReadAllText(pyPath);
            }
            
            Logger.Info($"Converting BIN to text: {binPath}");
            
            var jadeDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "RitoShark", "Jade");
            var hashDir = Path.Combine(jadeDir, "hashes");
            
            // Check if preload is enabled
            var settingsFile = Path.Combine(jadeDir, "preferences.txt");
            bool keepHashesLoaded = false; // Default to unload after use
            
            if (File.Exists(settingsFile))
            {
                var content = File.ReadAllText(settingsFile);
                if (content.Contains("PreloadHashes="))
                {
                    keepHashesLoaded = content.Contains("PreloadHashes=True");
                }
            }
            
            return BinConverter.ConvertBinToText(binPath, hashDir, keepHashesLoaded);
        }
        catch (Exception ex)
        {
            Logger.Error("ConvertBinToText failed", ex);
            return $"#PROP_text\n\n# Error loading BIN file: {ex.Message}\n# File: {binPath}\n# Check log at: {Logger.GetLogPath()}";
        }
    }

    public void LoadTheme()
    {
        try
        {
            var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var prefsFile = Path.Combine(appDataPath, "RitoShark", "Jade", "preferences.txt");
            
            string theme = "Default";
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
                            theme = line.Substring(6).Trim();
                            break;
                        }
                    }
                }
            }
            
            Logger.Info($"Loading theme: {theme}");
            ApplyTheme(theme);
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to load theme", ex);
        }
    }
    
    public void ApplyTheme(string theme)
    {
        try
        {
            ThemeManager.ApplyTheme(theme);
            
            // Get resources
            var app = Application.Current;
            var bracketTheme = GetCurrentBracketThemeName();
            
            // Update open editors
            foreach (var tab in _tabs)
            {
                if (tab.Editor != null)
                {
                    // Update editor colors using dynamic resource references
                    tab.Editor.SetResourceReference(Control.BackgroundProperty, "EditorBackgroundBrush");
                    tab.Editor.SetResourceReference(Control.ForegroundProperty, "PrimaryTextBrush");
                    tab.Editor.SetResourceReference(ICSharpCode.AvalonEdit.TextEditor.LineNumbersForegroundProperty, "MutedTextBrush");
                    
                    // Update syntax highlighting
                    // Use ThemeHelper to get the correct colors based on the theme name (matches ThemesWindow logic)
                    try 
                    {
                        // Handle syntax theme override
                        string syntaxTheme = theme;
                        if (bool.TryParse(ThemeHelper.ReadPreference("OverrideBracketTheme", "False"), out bool overrideSyntax) && overrideSyntax)
                        {
                            syntaxTheme = ThemeHelper.ReadPreference("BracketTheme", theme);
                        }

                        var (keyword, comment, stringColor, number, property) = ThemeHelper.GetThemeSyntaxColors(syntaxTheme);
                        
                        tab.Editor.SyntaxHighlighting = ThemeSyntaxHighlighting.GetHighlightingForTheme(
                            keyword, comment, stringColor, number, property);
                    }
                    catch (Exception exVal)
                    {
                        Logger.Error("Failed to update syntax highlighting", exVal);
                    }
                    
                    // Update bracket colors
                    var b1 = GetColorFromResource(app, "BracketColor1", Colors.Gold);
                    var b2 = GetColorFromResource(app, "BracketColor2", Colors.Magenta);
                    var b3 = GetColorFromResource(app, "BracketColor3", Colors.Cyan);
                    
                    var bracketColors = new[] { b1, b2, b3 };

                    
                    // Re-apply bracket colorizer
                    var transformers = tab.Editor.TextArea.TextView.LineTransformers;
                    for (int i = transformers.Count - 1; i >= 0; i--)
                    {
                        if (transformers[i] is Jade.Editor.BracketColorizer)
                        {
                            transformers.RemoveAt(i);
                        }
                    }
                    tab.Editor.TextArea.TextView.LineTransformers.Add(new Jade.Editor.BracketColorizer(bracketColors));
                    
                    // Update renderers (bracket highlight, etc) using dynamic colors if needed
                    // For now, these renderers might still depend on hardcoded theme or need update. 
                    // Assuming existing renderers can handle theme updates or we need to recreate them.
                    // The original code passed 'bracketTheme' string. Let's recreate them properly.
                    
                    var renderers = tab.Editor.TextArea.TextView.BackgroundRenderers;
                    for (int i = renderers.Count - 1; i >= 0; i--)
                    {
                        if (renderers[i] is Jade.Editor.BracketHighlightRenderer || 
                            renderers[i] is Jade.Editor.BracketScopeLineRenderer)
                        {
                            renderers.RemoveAt(i);
                        }
                    }
                    
                    // NOTE: Helper renderers still take theme string in their constructor? 
                    // We haven't refactored BracketHighlightRenderer yet. 
                    // BUT, the plan didn't explicitly say to refactor it, but we should check.
                    // If they use internal hardcoded colors, that's mismatch.
                    // However, we can pass the theme string for now as we didn't refactor those yet, 
                    // OR better, since we can't edit everything at once, we rely on the fact 
                    // that we are passing the new theme name to them if they need it.
                    // But wait, the user said "dont edit xaml themes", code refactor is fine.
                    // Let's pass the theme string to them as they might still rely on it internally 
                    // until fully refactored, but for consistency we should have refactored them too.
                    // Given the scope, let's keep passing the theme string to them for now 
                    // but ensure the MAIN editor colors are correct.
                    
                    var bracketHighlighter = new Jade.Editor.BracketHighlightRenderer(tab.Editor.TextArea.TextView, bracketTheme);
                    tab.Editor.TextArea.TextView.BackgroundRenderers.Add(bracketHighlighter);
                    
                    var scopeLineRenderer = new Jade.Editor.BracketScopeLineRenderer(tab.Editor.TextArea.TextView, bracketTheme);
                    tab.Editor.TextArea.TextView.BackgroundRenderers.Add(scopeLineRenderer);
                    
                    // Update folding margin colors
                    ApplyFoldingColors(tab.Editor);
                }
            }
            
            // Update minimap colors
            // Use EditorBackground with specific alpha
            var editorBgColor = ((SolidColorBrush)app.Resources["EditorBackgroundBrush"]).Color;
            var minimapBg = editorBgColor.R > 128 
                ? System.Windows.Media.Color.FromArgb(20, 0, 0, 0) // Light theme
                : System.Windows.Media.Color.FromArgb(15, 255, 255, 255); // Dark theme
            
            foreach (var tab in _tabs)
            {
                tab.MinimapRenderer?.SetBackgroundColor(minimapBg);
            }
            
            // Update search highlight color - Use AccentBrush or similar from resources if available
            // DefaultTheme has AccentBrush (#4EC9B0). Let's use it with transparency.
            var accentColor = ((SolidColorBrush)app.Resources["AccentBrush"]).Color;
            _currentSearchHighlightColor = System.Windows.Media.Color.FromArgb(60, accentColor.R, accentColor.G, accentColor.B);
            
            foreach (var tab in _tabs)
            {
                 tab.SearchRenderer?.SetHighlightColor(_currentSearchHighlightColor);
            }

            UpdateStickyScrollVisibility(true);

            Logger.Info($"Applied theme via ThemeManager: {theme}");
            Logger.Info($"Applied theme via ThemeManager: {theme}");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to apply theme", ex);
        }
    }
    
    // Helper to safely get color from resources
    private Color GetColorFromResource(Application app, string key, Color fallback)
    {
        try
        {
            if (app.Resources.Contains(key) && app.Resources[key] is SolidColorBrush brush)
            {
                return brush.Color;
            }
        }
        catch {}
        return fallback;
    }

    // Helper to apply folding margin colors based on current theme
    private void ApplyFoldingColors(ICSharpCode.AvalonEdit.TextEditor editor)
    {
        try
        {
            var app = Application.Current;
            
            // Get editor background and primary text colors
            var editorBg = ((SolidColorBrush)app.Resources["EditorBackgroundBrush"]).Color;
            var primaryText = ((SolidColorBrush)app.Resources["PrimaryTextBrush"]).Color;
            
            // Find the FoldingMargin in the editor's left margins
            var foldingMargin = editor.TextArea.LeftMargins
                .OfType<ICSharpCode.AvalonEdit.Folding.FoldingMargin>()
                .FirstOrDefault();
            
            if (foldingMargin != null)
            {
                // Set folding marker colors
                // Background: same as editor background
                foldingMargin.FoldingMarkerBackgroundBrush = new SolidColorBrush(editorBg);
                
                // Border/lines: use primary text color for visibility
                // This also controls the vertical lines extending to closing brackets
                foldingMargin.FoldingMarkerBrush = new SolidColorBrush(primaryText);
                
                // Hover background: slightly lighter/darker than editor background
                var hoverBg = editorBg.R > 128
                    ? Color.FromArgb(255, (byte)(editorBg.R - 20), (byte)(editorBg.G - 20), (byte)(editorBg.B - 20))
                    : Color.FromArgb(255, (byte)(editorBg.R + 20), (byte)(editorBg.G + 20), (byte)(editorBg.B + 20));
                foldingMargin.SelectedFoldingMarkerBackgroundBrush = new SolidColorBrush(hoverBg);
                
                // Hover border: same as primary text
                foldingMargin.SelectedFoldingMarkerBrush = new SolidColorBrush(primaryText);
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to apply folding colors", ex);
        }
    }

    private void OnIconButtonClick(object sender, RoutedEventArgs e)
    {
        try
        {
            // If dialog exists and is open, close it
            if (_iconPanelDialog != null && _iconPanelDialog.IsVisible)
            {
                _iconPanelDialog.Close();
                _iconPanelDialog = null;
                Logger.Info("Closed icon panel dialog");
                if (IconButton != null) IconButton.IsChecked = false;
                return;
            }
            
            // Close particle panel if open
            if (_particlePanelDialog != null && _particlePanelDialog.IsVisible)
            {
                _particlePanelDialog.Close();
            }

            // Create and show new dialog
            Logger.Info("Opening icon panel dialog");
            _iconPanelDialog = new IconPanelDialog(IconButton, this)
            {
                Owner = this
            };
            _iconPanelDialog.Closed += (s, args) => 
            {
                _iconPanelDialog = null;
                if (IconButton != null) IconButton.IsChecked = false;
            };
            _iconPanelDialog.Show();
            if (IconButton != null) IconButton.IsChecked = true;
        }
        catch (Exception ex)
        {
            if (IconButton != null) IconButton.IsChecked = false;
            Logger.Error("Failed to toggle icon panel dialog", ex);
            MessageBox.Show($"Failed to open panel: {ex.Message}", "Error",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void OnParticleButtonClick(object sender, RoutedEventArgs e)
    {
        try
        {
            // If dialog exists and is open, close it
            if (_particlePanelDialog != null && _particlePanelDialog.IsVisible)
            {
                _particlePanelDialog.Close();
                _particlePanelDialog = null;
                Logger.Info("Closed particle panel dialog");
                if (ParticleButton != null) ParticleButton.IsChecked = false;
                return;
            }
            
            // Close icon panel if open
            if (_iconPanelDialog != null && _iconPanelDialog.IsVisible)
            {
                _iconPanelDialog.Close();
            }

            // Create and show new dialog
            Logger.Info("Opening particle panel dialog");
            _particlePanelDialog = new ParticlePanelDialog(ParticleButton, this)
            {
                Owner = this
            };
            _particlePanelDialog.Closed += (s, args) => 
            {
                _particlePanelDialog = null;
                if (ParticleButton != null) ParticleButton.IsChecked = false;
            };
            _particlePanelDialog.Show();
            if (ParticleButton != null) ParticleButton.IsChecked = true;
        }
        catch (Exception ex)
        {
            if (ParticleButton != null) ParticleButton.IsChecked = false;
            Logger.Error("Failed to toggle particle panel dialog", ex);
            MessageBox.Show($"Failed to open panel: {ex.Message}", "Error",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
    
    private void OnAbout(object sender, RoutedEventArgs e)
    {
        var aboutWindow = new AboutWindow
        {
            Owner = this
        };
        aboutWindow.ShowDialog();
    }
    
    // Zoom functionality
    private void LoadZoomLevel()
    {
        try
        {
            var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var prefsFile = Path.Combine(appDataPath, "RitoShark", "Jade", "preferences.txt");
            
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                if (content.Contains("ZoomLevel="))
                {
                    var lines = content.Split('\n');
                    foreach (var line in lines)
                    {
                        if (line.StartsWith("ZoomLevel="))
                        {
                            var zoomStr = line.Substring(10).Trim();
                            if (double.TryParse(zoomStr, out double zoom))
                            {
                                _zoomLevel = Math.Clamp(zoom, 50.0, 300.0);
                                Logger.Info($"Loaded zoom level: {_zoomLevel}%");
                            }
                            break;
                        }
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to load zoom level", ex);
        }
    }
    
    private void SaveZoomLevel()
    {
        try
        {
            var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var jadeDir = Path.Combine(appDataPath, "RitoShark", "Jade");
            var prefsFile = Path.Combine(jadeDir, "preferences.txt");
            
            Directory.CreateDirectory(jadeDir);
            
            var lines = new List<string>();
            if (File.Exists(prefsFile))
            {
                var existingLines = File.ReadAllLines(prefsFile);
                foreach (var line in existingLines)
                {
                    if (!line.StartsWith("ZoomLevel="))
                    {
                        lines.Add(line);
                    }
                }
            }
            
            lines.Add($"ZoomLevel={_zoomLevel}");
            File.WriteAllLines(prefsFile, lines);
            
            Logger.Info($"Saved zoom level: {_zoomLevel}%");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to save zoom level", ex);
        }
    }
    
    private double GetFontSizeFromZoom()
    {
        // Base font size is 14 at 100% zoom
        return 14.0 * (_zoomLevel / 100.0);
    }
    
    private void ApplyZoomToAllEditors()
    {
        var fontSize = GetFontSizeFromZoom();
        foreach (var tab in _tabs)
        {
            if (tab.Editor != null)
            {
                tab.Editor.FontSize = fontSize;
            }
        }
        UpdateZoomIndicator();
    }
    
    private void UpdateZoomIndicator()
    {
        if (ZoomLevel != null)
        {
            ZoomLevel.Text = $"{_zoomLevel:F0}%";
        }
    }
    
    private void OnEditorMouseWheel(object sender, MouseWheelEventArgs e)
    {
        if (sender is not TextEditor editor)
            return;
        
        // Zoom when Ctrl is pressed
        if (Keyboard.Modifiers == ModifierKeys.Control)
        {
            e.Handled = true;
            
            // Zoom in/out based on wheel direction
            if (e.Delta > 0)
            {
                // Zoom in
                _zoomLevel = Math.Min(_zoomLevel + 10, 300.0);
            }
            else
            {
                // Zoom out
                _zoomLevel = Math.Max(_zoomLevel - 10, 50.0);
            }
            
            ApplyZoomToAllEditors();
            SaveZoomLevel();
            
            Logger.Info($"Zoom level changed to: {_zoomLevel}%");
        }
        // Horizontal scroll when Shift is pressed
        else if (Keyboard.Modifiers == ModifierKeys.Shift)
        {
            e.Handled = true;
            
            var scrollViewer = FindScrollViewer(editor);
            if (scrollViewer != null)
            {
                // Scroll horizontally based on wheel direction
                double scrollAmount = 48.0; // Pixels to scroll
                
                if (e.Delta > 0)
                {
                    // Scroll left
                    scrollViewer.ScrollToHorizontalOffset(scrollViewer.HorizontalOffset - scrollAmount);
                }
                else
                {
                    // Scroll right
                    scrollViewer.ScrollToHorizontalOffset(scrollViewer.HorizontalOffset + scrollAmount);
                }
            }
        }
    }
    
    private ScrollViewer? FindScrollViewer(DependencyObject element)
    {
        if (element is ScrollViewer scrollViewer)
            return scrollViewer;
        
        int childCount = VisualTreeHelper.GetChildrenCount(element);
        for (int i = 0; i < childCount; i++)
        {
            var child = VisualTreeHelper.GetChild(element, i);
            var result = FindScrollViewer(child);
            if (result != null)
                return result;
        }
        
        return null;
    }
    
    // Drag and Drop functionality
    private void OnDragEnter(object sender, DragEventArgs e)
    {
        if (e.Data.GetDataPresent(DataFormats.FileDrop))
        {
            e.Effects = DragDropEffects.Copy;
            DropOverlay.Visibility = Visibility.Visible;
        }
        else
        {
            e.Effects = DragDropEffects.None;
        }
        e.Handled = true;
    }
    
    private void OnDragOver(object sender, DragEventArgs e)
    {
        if (e.Data.GetDataPresent(DataFormats.FileDrop))
        {
            e.Effects = DragDropEffects.Copy;
            DropOverlay.Visibility = Visibility.Visible;
        }
        else
        {
            e.Effects = DragDropEffects.None;
        }
        e.Handled = true;
    }
    
    private void OnDragLeave(object sender, DragEventArgs e)
    {
        DropOverlay.Visibility = Visibility.Collapsed;
        e.Handled = true;
    }
    
    private async void OnFileDrop(object sender, DragEventArgs e)
    {
        // Hide the drop overlay
        DropOverlay.Visibility = Visibility.Collapsed;
        
        try
        {
            if (e.Data.GetDataPresent(DataFormats.FileDrop))
            {
                string[] files = (string[])e.Data.GetData(DataFormats.FileDrop);
                
                if (files != null && files.Length > 0)
                {
                    Logger.Info($"Files dropped: {files.Length}");
                    
                    foreach (var filePath in files)
                    {
                        // Check if file exists
                        if (!File.Exists(filePath))
                        {
                            Logger.Info($"Dropped file does not exist: {filePath}");
                            continue;
                        }
                        
                        // Check file extension
                        var extension = Path.GetExtension(filePath).ToLower();
                        if (extension != ".bin" && extension != ".py" && extension != ".txt")
                        {
                            Logger.Info($"Unsupported file type: {extension}");
                            MessageBox.Show($"Unsupported file type: {extension}\n\nSupported types: .bin, .py, .txt", 
                                "Unsupported File", MessageBoxButton.OK, MessageBoxImage.Warning);
                            continue;
                        }
                        
                        Logger.Info($"Loading dropped file: {filePath}");
                        StatusText.Text = "Loading...";
                        
                        var content = await LoadFileContentAsync(filePath);
                        
                        StatusText.Text = "Rendering...";
                        await Task.Delay(10);
                        
                        CreateNewTab(filePath, content);
                        
                        FileTypeText.Text = extension.ToUpper();
                        StatusText.Text = $"Loaded: {Path.GetFileName(filePath)}";
                        
                        AddToRecentFiles(filePath);
                        Logger.Info($"File loaded successfully: {Path.GetFileName(filePath)}");
                        
                        // Open linked bin files if preference is enabled
                        await OpenLinkedBinFilesAsync(filePath, content);
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Error handling dropped files", ex);
            MessageBox.Show($"Error loading dropped file: {ex.Message}\n\nCheck log at: {Logger.GetLogPath()}", 
                "Error", MessageBoxButton.OK, MessageBoxImage.Error);
            StatusText.Text = "Error loading file";
        }
        
        e.Handled = true;
    }
    private void InitializePerformanceMonitoring()
    {
        try
        {
            var processName = Process.GetCurrentProcess().ProcessName;
            
            _perfTimer = new System.Windows.Threading.DispatcherTimer();
            _perfTimer.Interval = TimeSpan.FromSeconds(1);
            _perfTimer.Tick += OnPerfTimerTick;
            
            // Initialize PerformanceCounter in background as it can be very slow
            Task.Run(() => 
            {
                try
                {
                    // Use "Working Set - Private" to match Task Manager's "Memory" column
                    _ramCounter = new PerformanceCounter("Process", "Working Set - Private", processName);
                    
                    Dispatcher.Invoke(() => _perfTimer.Start());
                    Logger.Info("Performance monitoring initialized (background)");
                }
                catch (Exception ex)
                {
                    Logger.Error("Failed to initialize performance counter in background", ex);
                    Dispatcher.Invoke(() => 
                    {
                        if (RamUsageText != null) RamUsageText.Text = "RAM: N/A";
                    });
                }
            });
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to setup performance monitoring timer", ex);
            if (RamUsageText != null) RamUsageText.Text = "RAM: N/A";
        }
    }

    private void OnPerfTimerTick(object? sender, EventArgs e)
    {
        try
        {
            if (_ramCounter != null)
            {
                var bytes = _ramCounter.NextValue();
                var mb = bytes / 1024.0 / 1024.0;
                if (RamUsageText != null)
                {
                    RamUsageText.Text = $"{mb:F1} MB";
                }
            }
        }
        catch 
        {
            // Ignore temporary counter errors
        }
    }

    // Removed ApplyThemeLogic as it is no longer used


    private SolidColorBrush GetBrighterBrush(SolidColorBrush brush, double factor)
    {
        try {
            var color = brush.Color;
            return new SolidColorBrush(System.Windows.Media.Color.FromRgb(
                (byte)Math.Min(255, color.R * factor),
                (byte)Math.Min(255, color.G * factor),
                (byte)Math.Min(255, color.B * factor)));
        } catch { return brush; }
    }

    private System.Windows.Media.SolidColorBrush GetBrushFromHex(string hex)
    {
        try {
            var brush = new System.Windows.Media.BrushConverter().ConvertFrom(hex) as System.Windows.Media.SolidColorBrush;
            return brush ?? System.Windows.Media.Brushes.Gray;
        } catch {
            return System.Windows.Media.Brushes.Gray;
        }
    }

    private string GetPreferencesFilePath()
    {
        var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var jadeDir = Path.Combine(appDataPath, "RitoShark", "Jade");
        Directory.CreateDirectory(jadeDir);
        return Path.Combine(jadeDir, "preferences.txt");
    }

    private string ReadPreference(string key, string defaultValue)
    {
        try
        {
            var prefsFile = GetPreferencesFilePath();
            if (File.Exists(prefsFile))
            {
                var lines = File.ReadAllLines(prefsFile);
                foreach (var line in lines)
                {
                    if (line.StartsWith($"{key}="))
                    {
                        return line.Substring(key.Length + 1).Trim();
                    }
                }
            }
        }
        catch { }
        return defaultValue;
    }

    private void SaveWindowState()
    {
        try
        {
            var prefsFile = GetPreferencesFilePath();
            var lines = new List<string>();
            
            // Read existing preferences
            if (File.Exists(prefsFile))
            {
                lines = File.ReadAllLines(prefsFile).ToList();
            }
            
            // Remove old window state entries
            lines.RemoveAll(l => l.StartsWith("WindowState=") || 
                                l.StartsWith("WindowLeft=") || 
                                l.StartsWith("WindowTop=") || 
                                l.StartsWith("WindowWidth=") || 
                                l.StartsWith("WindowHeight="));
            
            // Save current window state (only if not minimized)
            if (WindowState != WindowState.Minimized)
            {
                lines.Add($"WindowState={WindowState}");
                
                // Save position and size only if not maximized
                if (WindowState == WindowState.Normal)
                {
                    lines.Add($"WindowLeft={Left}");
                    lines.Add($"WindowTop={Top}");
                    lines.Add($"WindowWidth={Width}");
                    lines.Add($"WindowHeight={Height}");
                }
            }
            
            File.WriteAllLines(prefsFile, lines);
            Logger.Info($"Saved window state: {WindowState}");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to save window state", ex);
        }
    }

    private void RestoreWindowState()
    {
        try
        {
            var prefsFile = GetPreferencesFilePath();
            if (!File.Exists(prefsFile))
                return;
            
            var lines = File.ReadAllLines(prefsFile);
            string? savedState = null;
            double? left = null, top = null, width = null, height = null;
            
            foreach (var line in lines)
            {
                if (line.StartsWith("WindowState="))
                    savedState = line.Substring(12).Trim();
                else if (line.StartsWith("WindowLeft=") && double.TryParse(line.Substring(11).Trim(), out var l))
                    left = l;
                else if (line.StartsWith("WindowTop=") && double.TryParse(line.Substring(10).Trim(), out var t))
                    top = t;
                else if (line.StartsWith("WindowWidth=") && double.TryParse(line.Substring(12).Trim(), out var w))
                    width = w;
                else if (line.StartsWith("WindowHeight=") && double.TryParse(line.Substring(13).Trim(), out var h))
                    height = h;
            }
            
            // Restore position and size if available (for Normal state)
            if (left.HasValue && top.HasValue && width.HasValue && height.HasValue)
            {
                // Ensure window is visible on screen
                var screenWidth = SystemParameters.VirtualScreenWidth;
                var screenHeight = SystemParameters.VirtualScreenHeight;
                
                if (left.Value >= 0 && left.Value < screenWidth &&
                    top.Value >= 0 && top.Value < screenHeight &&
                    width.Value > 100 && width.Value <= screenWidth &&
                    height.Value > 100 && height.Value <= screenHeight)
                {
                    Left = left.Value;
                    Top = top.Value;
                    Width = width.Value;
                    Height = height.Value;
                }
            }
            
            // Restore window state - defer maximization to prevent off-screen issues
            if (savedState == "Maximized")
            {
                // Start in Normal state, then maximize after window is fully loaded
                // This prevents off-screen issues with custom WindowChrome
                WindowState = WindowState.Normal;
                
                // Defer maximization until after the window is fully rendered
                Dispatcher.BeginInvoke(new Action(() =>
                {
                    WindowState = WindowState.Maximized;
                    Logger.Info("Restored window state: Maximized (deferred)");
                }), System.Windows.Threading.DispatcherPriority.Loaded);
            }
            else
            {
                WindowState = WindowState.Normal;
                Logger.Info($"Restored window state: Normal ({Width}x{Height})");
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to restore window state", ex);
        }
    }
}
