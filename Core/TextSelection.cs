namespace Jade.Core;

/// <summary>
/// Represents text selection with start and end positions
/// </summary>
public class TextSelection
{
    public int StartLine { get; set; }
    public int StartColumn { get; set; }
    public int EndLine { get; set; }
    public int EndColumn { get; set; }

    public bool HasSelection =>
        StartLine != EndLine || StartColumn != EndColumn;

    public void Clear(int line, int column)
    {
        StartLine = EndLine = line;
        StartColumn = EndColumn = column;
    }

    public void Normalize()
    {
        if (EndLine < StartLine || (EndLine == StartLine && EndColumn < StartColumn))
        {
            (StartLine, EndLine) = (EndLine, StartLine);
            (StartColumn, EndColumn) = (EndColumn, StartColumn);
        }
    }
}
