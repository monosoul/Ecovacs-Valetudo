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
} from "@mui/material";

const SUCTION_OPTIONS = [
    {value: 0, label: "Standard"},
    {value: 1, label: "Strong"},
    {value: 2, label: "Max"},
    {value: 1000, label: "Quiet"},
] as const;

const WATER_OPTIONS = [
    {value: 0, label: "Low"},
    {value: 1, label: "Medium"},
    {value: 2, label: "High"},
    {value: 3, label: "Max"},
] as const;

const TIMES_OPTIONS = [
    {value: 1, label: "Normal (1 pass)"},
    {value: 2, label: "Deep (2 passes)"},
] as const;

export interface RoomCleaningPreferences {
    times?: number;
    water?: number;
    suction?: number;
}

interface SegmentCleaningPreferencesDialogProps {
    open: boolean;
    onClose: () => void;
    segmentName: string;
    preferences: RoomCleaningPreferences | null | undefined;
    onSave: (preferences: { suction: number; water: number; times: number }) => void;
    isSaving: boolean;
}

const SegmentCleaningPreferencesDialog = (props: SegmentCleaningPreferencesDialogProps): React.ReactElement => {
    const {open, onClose, segmentName, preferences, onSave, isSaving} = props;

    const [suction, setSuction] = React.useState<number>(0);
    const [water, setWater] = React.useState<number>(0);
    const [times, setTimes] = React.useState<number>(1);

    React.useEffect(() => {
        if (open) {
            setSuction(preferences?.suction ?? 0);
            setWater(preferences?.water ?? 0);
            setTimes(preferences?.times ?? 1);
        }
    }, [open, preferences]);

    const handleSave = React.useCallback(() => {
        onSave({suction: suction, water: water, times: times});
    }, [onSave, suction, water, times]);

    return (
        <Dialog open={open} onClose={onClose} sx={{userSelect: "none"}}>
            <DialogTitle>Room Preferences</DialogTitle>
            <DialogContent>
                <DialogContentText style={{marginBottom: "1rem"}}>
                    Per-room cleaning preferences for &apos;{segmentName}&apos;.
                </DialogContentText>

                <FormControl fullWidth variant="standard" style={{marginBottom: "1rem"}}>
                    <InputLabel>Fan Speed</InputLabel>
                    <Select
                        value={suction}
                        onChange={(e) => {
                            setSuction(Number(e.target.value));
                        }}
                    >
                        {SUCTION_OPTIONS.map((opt) => (
                            <MenuItem key={opt.value} value={opt.value}>{opt.label}</MenuItem>
                        ))}
                    </Select>
                </FormControl>

                <FormControl fullWidth variant="standard" style={{marginBottom: "1rem"}}>
                    <InputLabel>Water Usage</InputLabel>
                    <Select
                        value={water}
                        onChange={(e) => {
                            setWater(Number(e.target.value));
                        }}
                    >
                        {WATER_OPTIONS.map((opt) => (
                            <MenuItem key={opt.value} value={opt.value}>{opt.label}</MenuItem>
                        ))}
                    </Select>
                </FormControl>

                <FormControl fullWidth variant="standard">
                    <InputLabel>Clean Route</InputLabel>
                    <Select
                        value={times}
                        onChange={(e) => {
                            setTimes(Number(e.target.value));
                        }}
                    >
                        {TIMES_OPTIONS.map((opt) => (
                            <MenuItem key={opt.value} value={opt.value}>{opt.label}</MenuItem>
                        ))}
                    </Select>
                </FormControl>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose} disabled={isSaving}>Cancel</Button>
                <Button onClick={handleSave} disabled={isSaving}>
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

export default SegmentCleaningPreferencesDialog;
