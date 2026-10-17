// AFU decoding and Segal estimation adapted from Xuan-lprk/smart-body-scale-IOS
// c11f1b925653b5d14b46eb3b02f6d68551d7e944. SPDX-License-Identifier: GPL-3.0-only
// See LICENSE.upstream. These estimates are not the manufacturer's results.
package afu

import (
	"encoding/hex"
	"errors"
	"math"
	"time"
)

const Profile = "afu-wl-tz-a1"
const ParserVersion = "afu-tz-a1-v2"
const AlgorithmVersion = "segal_1988_v1"

type Packet struct {
	Raw         []byte
	WeightGrams int
	Stable      bool
	ADCs        []int
}

// Only the wrapped D5/D6 formats verified on TZ-A1 are accepted. D8 history
// has no verified timestamp/sequence semantics and is deliberately excluded.
func Parse(rawHex string, opcode byte) (Packet, error) {
	raw, err := hex.DecodeString(rawHex)
	if err != nil || len(raw) < 20 || len(raw) > 21 || raw[0] != 0xac || raw[len(raw)-3] != 0x29 || raw[len(raw)-2] != opcode {
		return Packet{}, errors.New("invalid AFU packet header, length or opcode")
	}
	p := Packet{Raw: raw}
	switch opcode {
	case 0xd5:
		if len(raw) != 20 {
			return p, errors.New("unsupported AFU weight layout")
		}
		if raw[3] < 0x68 {
			return p, errors.New("invalid AFU weight encoding")
		}
		p.WeightGrams = int(raw[3]-0x68)<<16 | int(raw[4])<<8 | int(raw[5])
		// Status 02 is also present in changing live readings. The high bit
		// locks the displayed result; both flags are required on TZ-A1.
		p.Stable = raw[2]&0x80 != 0 && raw[6] == 2
	case 0xd6:
		if raw[2] != 2 {
			return p, errors.New("unsupported AFU ADC layout")
		}
		p.ADCs = []int{int(raw[4])<<8 | int(raw[5]), int(raw[6])<<8 | int(raw[7])}
		p.WeightGrams = (int(raw[9])<<24 | int(raw[10])<<16 | int(raw[11])<<8 | int(raw[12])) & 0x3ffff
	default:
		return p, errors.New("unsupported AFU opcode")
	}
	if p.WeightGrams < 1000 || p.WeightGrams > 300000 {
		return p, errors.New("AFU weight outside supported range")
	}
	return p, nil
}

type Person struct {
	Sex        string  `json:"sex"`
	HeightCM   float64 `json:"height_cm"`
	BirthDate  string  `json:"birth_date"`
	BirthMonth string  `json:"birth_month,omitempty"`
}
type Estimate struct {
	BMI              float64 `json:"bmi"`
	BodyFatPct       float64 `json:"body_fat_pct"`
	Status           string  `json:"body_fat_status"`
	ADCIndex         int     `json:"adc_index"`
	Resistance       float64 `json:"resistance"`
	Age              int     `json:"age"`
	AgeApproximate   bool    `json:"age_approximate"`
	AlgorithmVersion string  `json:"algorithm_version"`
	ProfileSnapshot  Person  `json:"profile_snapshot"`
}

func Normalize(adc int, weightKG float64) float64 {
	x := float64(adc)
	if adc >= 1500 {
		x = (((x - 1000) - weightKG*4) / 0.6) / 10
	}
	return math.Round(x*100) / 100
}

func Calculate(weightGrams int, adcs []int, adcIndex int, p Person, at *time.Time) Estimate {
	r := Estimate{Status: "missing_adc", ADCIndex: adcIndex, ProfileSnapshot: p}
	if adcIndex < 0 || adcIndex >= len(adcs) {
		return r
	}
	w := float64(weightGrams) / 1000
	z := Normalize(adcs[adcIndex], w)
	if z < 100 || z > 1500 {
		return r
	}
	r.Resistance = z
	r.Status = "missing_profile"
	birth, err := time.Parse("2006-01-02", p.BirthDate)
	monthOnly := p.BirthDate == "" && p.BirthMonth != ""
	if monthOnly {
		birth, err = time.Parse("2006-01", p.BirthMonth)
		r.AgeApproximate = true
	}
	if err != nil || p.HeightCM < 50 || p.HeightCM > 250 || (p.Sex != "male" && p.Sex != "female") {
		return r
	}
	if at == nil {
		r.Status = "invalid_time"
		return r
	}
	local := at.In(time.FixedZone("Asia/Shanghai", 8*3600))
	age := local.Year() - birth.Year()
	if local.Month() < birth.Month() || (!monthOnly && local.Month() == birth.Month() && local.Day() < birth.Day()) {
		age--
	}
	if age < 0 || age > 120 {
		return r
	}
	r.Age = age
	h2 := p.HeightCM * p.HeightCM
	var ffm float64
	if p.Sex == "male" {
		ffm = 9.33285 + 0.00066360*h2 - 0.02117*z + 0.62854*w - 0.12380*float64(age)
		if 100*(w-ffm)/w >= 20 {
			ffm = 14.52435 + 0.00088580*h2 - 0.02999*z + 0.42688*w - 0.07002*float64(age)
		}
	} else {
		ffm = 10.43485 + 0.00064602*h2 - 0.01397*z + 0.42087*w
		if 100*(w-ffm)/w >= 30 {
			ffm = 9.37938 + 0.00091186*h2 - 0.01466*z + 0.29990*w - 0.07012*float64(age)
		}
	}
	ffm = math.Max(w*0.35, math.Min(w*0.97, ffm))
	minimum := 8.0
	if p.Sex == "male" {
		minimum = 3
	}
	r.BMI = math.Round(w/(h2/10000)*100) / 100
	r.BodyFatPct = math.Round(math.Max(minimum, math.Min(60, 100*(w-ffm)/w))*100) / 100
	r.Status = "estimated"
	r.AlgorithmVersion = AlgorithmVersion
	return r
}
