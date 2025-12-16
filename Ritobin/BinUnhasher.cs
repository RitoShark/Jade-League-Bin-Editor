using System;

namespace Jade.Ritobin;

public class BinUnhasher
{
    public void UnhashBin(Bin bin)
    {
        foreach (var section in bin.Sections)
        {
            UnhashValue(section.Value);
        }
    }

    private void UnhashValue(BinValue value)
    {
        switch (value)
        {
            case BinHash h:
                h.Value = UnhashFNV1a(h.Value);
                break;
            case BinFile f:
                f.Value = UnhashXXH64(f.Value);
                break;
            case BinLink l:
                l.Value = UnhashFNV1a(l.Value);
                break;
            case BinPointer p:
                p.Name = UnhashFNV1a(p.Name);
                foreach (var field in p.Items)
                {
                    field.Key = UnhashFNV1a(field.Key);
                    UnhashValue(field.Value);
                }
                break;
            case BinEmbed e:
                e.Name = UnhashFNV1a(e.Name);
                foreach (var field in e.Items)
                {
                    field.Key = UnhashFNV1a(field.Key);
                    UnhashValue(field.Value);
                }
                break;
            case BinList list:
                foreach (var item in list.Items)
                {
                    UnhashValue(item);
                }
                break;
            case BinList2 list2:
                foreach (var item in list2.Items)
                {
                    UnhashValue(item);
                }
                break;
            case BinOption option:
                foreach (var item in option.Items)
                {
                    UnhashValue(item);
                }
                break;
            case BinMap map:
                foreach (var kvp in map.Items)
                {
                    UnhashValue(kvp.Key);
                    UnhashValue(kvp.Value);
                }
                break;
            // Primitives - no unhashing needed
            case BinNone:
            case BinBool:
            case BinI8:
            case BinU8:
            case BinI16:
            case BinU16:
            case BinI32:
            case BinU32:
            case BinI64:
            case BinU64:
            case BinF32:
            case BinVec2:
            case BinVec3:
            case BinVec4:
            case BinMtx44:
            case BinRgba:
            case BinString:
            case BinFlag:
                break;
        }
    }

    private FNV1a UnhashFNV1a(FNV1a value)
    {
        if (string.IsNullOrEmpty(value.String) && value.Hash != 0)
        {
            var found = HashManager.GetFNV1a(value.Hash);
            if (found != null)
            {
                return new FNV1a(value.Hash, found);
            }
        }
        return value;
    }

    private XXH64 UnhashXXH64(XXH64 value)
    {
        if (string.IsNullOrEmpty(value.String) && value.Hash != 0)
        {
            var found = HashManager.GetXXH64(value.Hash);
            if (found != null)
            {
                return new XXH64(value.Hash, found);
            }
        }
        return value;
    }
}
