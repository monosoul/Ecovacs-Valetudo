import React from "react";
import {
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogContentText,
    DialogTitle,
    FormControl,
    InputLabel,
    MenuItem,
    Select,
    Typography,
} from "@mui/material";

interface SegmentCleaningSequenceDialogProps {
    open: boolean;
    onClose: () => void;
    segmentNames: Record<string, string>;
    segmentSequences: Record<string, number>;
    onSave: (sequence: Record<string, number>) => void;
    isSaving: boolean;
}

const SegmentCleaningSequenceDialog = (props: SegmentCleaningSequenceDialogProps): React.ReactElement => {
    const {open, onClose, segmentNames, segmentSequences, onSave, isSaving} = props;

    const [localSequence, setLocalSequence] = React.useState<Record<string, number>>({});

    const segmentIds = React.useMemo(() => {
        return Object.keys(segmentNames).sort((a, b) => Number(a) - Number(b));
    }, [segmentNames]);

    React.useEffect(() => {
        if (open) {
            const initial: Record<string, number> = {};
            for (const id of Object.keys(segmentNames)) {
                initial[id] = segmentSequences[id] ?? 0;
            }
            setLocalSequence(initial);
        }
    }, [open, segmentNames, segmentSequences]);

    // Build position options: 0 (none) plus 1..N
    const positionOptions = React.useMemo(() => {
        const opts = [{value: 0, label: "None"}];
        for (let i = 1; i <= segmentIds.length; i++) {
            opts.push({value: i, label: String(i)});
        }
        return opts;
    }, [segmentIds]);

    // Track which positions are used (excluding the current segment)
    const usedPositions = React.useMemo(() => {
        const used = new Set<number>();
        for (const [, pos] of Object.entries(localSequence)) {
            if (pos > 0) {
                used.add(pos);
            }
        }
        return used;
    }, [localSequence]);

    // Check for duplicates
    const hasDuplicates = React.useMemo(() => {
        const seen = new Set<number>();
        for (const [, pos] of Object.entries(localSequence)) {
            if (pos > 0) {
                if (seen.has(pos)) {
                    return true;
                }
                seen.add(pos);
            }
        }
        return false;
    }, [localSequence]);

    const handlePositionChange = React.useCallback((segmentId: string, newPos: number) => {
        setLocalSequence(prev => ({...prev, [segmentId]: newPos}));
    }, []);

    const handleClear = React.useCallback(() => {
        const cleared: Record<string, number> = {};
        for (const id of Object.keys(localSequence)) {
            cleared[id] = 0;
        }
        setLocalSequence(cleared);
    }, [localSequence]);

    const handleSave = React.useCallback(() => {
        onSave(localSequence);
    }, [onSave, localSequence]);

    return (
        <Dialog open={open} onClose={onClose} sx={{userSelect: "none"}} maxWidth="xs" fullWidth>
            <DialogTitle>Room Cleaning Order</DialogTitle>
            <DialogContent>
                <DialogContentText style={{marginBottom: "1rem"}}>
                    Set the cleaning order for each room. Rooms set to &quot;None&quot; will not have a fixed order.
                </DialogContentText>

                {segmentIds.map((id) => {
                    const currentPos = localSequence[id] ?? 0;
                    const name = segmentNames[id] ?? id;

                    return (
                        <FormControl
                            key={id}
                            fullWidth
                            variant="standard"
                            style={{marginBottom: "0.75rem"}}
                        >
                            <InputLabel>{name}</InputLabel>
                            <Select
                                value={currentPos}
                                onChange={(e) => {
                                    handlePositionChange(id, Number(e.target.value));
                                }}
                            >
                                {positionOptions.map((opt) => {
                                    const isUsedByOther = opt.value > 0 &&
                                        usedPositions.has(opt.value) &&
                                        currentPos !== opt.value;
                                    return (
                                        <MenuItem
                                            key={opt.value}
                                            value={opt.value}
                                            disabled={isUsedByOther}
                                        >
                                            {opt.label}
                                        </MenuItem>
                                    );
                                })}
                            </Select>
                        </FormControl>
                    );
                })}

                {hasDuplicates && (
                    <Typography color="error" variant="body2" style={{marginTop: "0.5rem"}}>
                        Duplicate positions detected. Each position must be unique.
                    </Typography>
                )}
            </DialogContent>
            <DialogActions>
                <Button onClick={handleClear} disabled={isSaving}>Clear</Button>
                <Button onClick={onClose} disabled={isSaving}>Cancel</Button>
                <Button onClick={handleSave} disabled={isSaving || hasDuplicates}>
                    Save
                    {isSaving && (
                        <CircularProgress
                            color="inherit"
                            size={18}
                            style={{marginLeft: 10}}
                        />
                    )}
                </Button>
            </DialogActions>
        </Dialog>
    );
};

export default SegmentCleaningSequenceDialog;
